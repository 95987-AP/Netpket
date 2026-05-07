import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { SCENARIOS, SCENARIO_MAP } from "./data/scenarios";
import { cliPrompt, commandSuggestions, completeCliCommand, isTerminalClearCommand, navigateHistory, pushHistory, runCliCommand, selectedInterfacesText } from "./lib/cli";
import { deepClone, firstUsableIp, formatInterface, getInterface, ipInSubnet, isValidIp, isValidMask, lastUsableIp, maskToPrefix, networkAddress, prefixToMask } from "./lib/ip";
import { addEvent, addTerminalLine, addTerminalOutput, createLabState, deviceStatus, dynamicRoutingLinkStatus, MODES, normalizeDevice, selectedDevice, Simulator, STORAGE_KEY } from "./lib/simulator";
import { buildRecipeLab, previewRecipe, type RecipeOptions, type RecipePreview } from "./lib/topologyRecipe";
import { validateScenario } from "./lib/validation";
import type { Device, DeviceType, LabState, Link, NetworkInterface, ValidationResult } from "./types";

const SESSION_KEY = "netpket-session-v1";
const LEFT_PANEL_KEY = "netpket-left-panel-open";
const PANEL_SIZE_KEY = "netpket-panel-sizes";
const GUIDE_KEY = "netpket-first-run-guide-dismissed";
const WORKSPACE_WIDTH = 1000;
const WORKSPACE_HEIGHT = 430;
const DEVICE_WIDTH = 170;
const DEVICE_MIN_HEIGHT = 118;
const DEVICE_ANCHOR_X = DEVICE_WIDTH / 2;
const DEVICE_ANCHOR_Y = 58;
const WORKSPACE_FREE_MARGIN = 820;
const DEFAULT_PANEL_SIZES = { left: 292, right: 338, bottom: 230 };
const DEFAULT_VIEWPORT = { zoom: 1, x: 0, y: 0 };

type PanelSizes = typeof DEFAULT_PANEL_SIZES;
type ResizeKind = "left" | "right" | "bottom";
type WorkspaceViewport = typeof DEFAULT_VIEWPORT;
type ObjectiveState = "done" | "active" | "idle";
type LampState = "ok" | "warn" | "bad" | "off";
type ServiceLamp = { label: string; state: LampState; title: string };
type IpMaskRow = { mask: string; prefix: number; hostRangeStart: string; hostRangeEnd: string; availableHosts: number };
type PaletteAction = { id: string; title: string; detail: string; run: () => void | Promise<void> };
type WorkspaceBounds = { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number };
type AddDeviceMenu = { clientX: number; clientY: number; x: number; y: number } | null;
type Point = { x: number; y: number };
type RoutedLink = { points: Point[]; path: string; fromLabel: Point; toLabel: Point };
type LinkEndpointSide = "left" | "right" | "top" | "bottom";
type LinkBadgeLayout = { x: number; y: number; width: number; height: number; textX: number; textY: number };
type RoutedLinkLayout = { link: Link; route: RoutedLink; fromBadge: LinkBadgeLayout; toBadge: LinkBadgeLayout };
type ServerServiceName = keyof Device["services"];
type ServerServicesTab = "dhcp" | "dns" | "www" | "mail";
type ServerServiceAction =
  | { type: "toggle"; service: ServerServiceName; enabled: boolean }
  | { type: "dhcp-save"; pool: Device["dhcpPools"][number] }
  | { type: "dhcp-delete"; name: string }
  | { type: "dns-save"; name: string; ip: string }
  | { type: "dns-delete"; name: string }
  | { type: "www-save"; content: string }
  | { type: "mail-user-save"; user: string }
  | { type: "mail-clear"; user: string };

const ADD_DEVICE_TYPES: DeviceType[] = ["router", "switch", "pc", "server", "cloud"];

const DOMAIN_BY_SCENARIO: Record<string, string> = {
  s3: "intranet.local",
  s6: "lab.local",
  s7: "troubleshoot.local",
};

const IP_TABLE_BASE_NETWORK = "192.168.1.0";

const IP_MASK_ROWS: IpMaskRow[] = Array.from({ length: 32 }, (_, index) => {
  const prefix = 32 - index;
  const mask = prefixToMask(prefix);
  const subnetNetwork = networkAddress(IP_TABLE_BASE_NETWORK, mask);
  const availableHosts = usableHostCountForPrefix(prefix);
  return {
    mask,
    prefix,
    hostRangeStart: firstUsableIp(subnetNetwork, mask),
    hostRangeEnd: lastUsableIp(subnetNetwork, mask),
    availableHosts,
  };
});

async function yieldToBrowser() {
  const maybeScheduler = (globalThis as typeof globalThis & { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (maybeScheduler?.yield) {
    await maybeScheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function initialState(): LabState {
  const savedTheme = window.localStorage.getItem("networklab-theme");
  const theme = savedTheme === "dark" ? "dark" : "light";
  const rawSession = window.localStorage.getItem(SESSION_KEY);
  let scenarioId = "s1";
  let selectedDeviceId = "";
  let mode = "Learn";
  try {
    const session = rawSession ? JSON.parse(rawSession) as Partial<Pick<LabState, "currentScenarioId" | "selectedDeviceId" | "mode">> : null;
    if (session?.currentScenarioId && SCENARIO_MAP[session.currentScenarioId] && session.currentScenarioId !== "recipe") scenarioId = session.currentScenarioId;
    selectedDeviceId = session?.selectedDeviceId || "";
    mode = typeof session?.mode === "string" ? session.mode : "Learn";
  } catch {
    window.localStorage.removeItem(SESSION_KEY);
  }
  const created = createLabState(SCENARIO_MAP[scenarioId], { theme, mode });
  if (selectedDeviceId && created.devices[selectedDeviceId]) created.selectedDeviceId = selectedDeviceId;
  return created;
}

function initialLeftPanelOpen(): boolean {
  return window.localStorage.getItem(LEFT_PANEL_KEY) !== "false";
}

function initialGuideOpen(): boolean {
  return window.localStorage.getItem(GUIDE_KEY) !== "true";
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function initialPanelSizes(): PanelSizes {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PANEL_SIZE_KEY) || "") as Partial<PanelSizes>;
    return {
      left: clamp(Number(parsed.left) || DEFAULT_PANEL_SIZES.left, 220, 420),
      right: clamp(Number(parsed.right) || DEFAULT_PANEL_SIZES.right, 280, 520),
      bottom: clamp(Number(parsed.bottom) || DEFAULT_PANEL_SIZES.bottom, 150, 360),
    };
  } catch {
    return DEFAULT_PANEL_SIZES;
  }
}

function computeWorkspaceBounds(devices: Device[]): WorkspaceBounds {
  const minX = Math.min(0, ...devices.map((device) => device.x));
  const minY = Math.min(0, ...devices.map((device) => device.y));
  const maxDeviceX = devices.length ? Math.max(...devices.map((device) => device.x + DEVICE_WIDTH)) : WORKSPACE_WIDTH;
  const maxDeviceY = devices.length ? Math.max(...devices.map((device) => device.y + DEVICE_MIN_HEIGHT)) : WORKSPACE_HEIGHT;
  const maxX = Math.max(WORKSPACE_WIDTH, maxDeviceX) + WORKSPACE_FREE_MARGIN;
  const maxY = Math.max(WORKSPACE_HEIGHT, maxDeviceY) + WORKSPACE_FREE_MARGIN;
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function computeDeviceEnvelope(devices: Device[]): WorkspaceBounds {
  if (!devices.length) return computeWorkspaceBounds([]);
  const minX = Math.min(...devices.map((device) => device.x));
  const minY = Math.min(...devices.map((device) => device.y));
  const maxX = Math.max(...devices.map((device) => device.x + DEVICE_WIDTH));
  const maxY = Math.max(...devices.map((device) => device.y + DEVICE_MIN_HEIGHT));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

export default function App() {
  const [lab, setLab] = useState<LabState>(initialState);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [command, setCommand] = useState("");
  const [leftPanelOpen, setLeftPanelOpen] = useState(initialLeftPanelOpen);
  const [panelSizes, setPanelSizes] = useState<PanelSizes>(initialPanelSizes);
  const [viewport, setViewport] = useState<WorkspaceViewport>(DEFAULT_VIEWPORT);
  const [selectedLinkId, setSelectedLinkId] = useState<string | null>(null);
  const [addDeviceMenu, setAddDeviceMenu] = useState<AddDeviceMenu>(null);
  const [cableSourceId, setCableSourceId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [guideOpen, setGuideOpen] = useState(initialGuideOpen);
  const [ipTableOpen, setIpTableOpen] = useState(false);
  const [recipeDraft, setRecipeDraft] = useState<RecipeOptions>({
    routerCount: 4,
    innerPattern: "15+1.38.47.1",
    innerMask: "255.255.255.252",
    outerPattern: "15+10.1.1.1",
    outerMask: "255.255.255.0",
    staticRoutes: false,
    autoNoShutdown: true,
  });
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const pendingDragRef = useRef<{ x: number; y: number } | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const resizeRef = useRef<{ kind: ResizeKind; x: number; y: number; sizes: PanelSizes } | null>(null);

  const scenario = SCENARIO_MAP[lab.currentScenarioId];
  const selected = selectedDevice(lab);
  const simulator = useMemo(() => new Simulator(lab), [lab]);
  const recipePreview = useMemo(() => previewRecipe(recipeDraft), [recipeDraft]);
  const workspaceBounds = useMemo(() => computeWorkspaceBounds(Object.values(lab.devices)), [lab.devices]);
  const routedLinks = useMemo(() => layoutRoutedLinks(lab), [lab]);
  const scenarioProgress = lab.progress[lab.currentScenarioId];
  const scenarioScore = scenarioProgress?.score ?? lab.score;
  const scenarioDomain = DOMAIN_BY_SCENARIO[lab.currentScenarioId] || "";
  const selectedLink = selectedLinkId ? lab.links.find((link) => link.id === selectedLinkId) || null : null;
  const cableSource = cableSourceId ? lab.devices[cableSourceId] || null : null;
  const cliHints = commandSuggestions(lab, command).slice(0, 4);
  const cliErrorHints = commandHintsForLatestError(lab, selected).slice(0, 3);
  const packetFlowPath = useMemo(() => flowPathForLab(lab), [lab]);
  const layoutStyle = {
    "--left-panel-width": `${panelSizes.left}px`,
    "--right-panel-width": `${panelSizes.right}px`,
    "--bottom-panel-height": `${panelSizes.bottom}px`,
  } as CSSProperties;
  const workspaceContentStyle = {
    width: workspaceBounds.width * viewport.zoom,
    height: workspaceBounds.height * viewport.zoom,
  } as CSSProperties;
  const workspaceCanvasStyle = {
    width: workspaceBounds.width,
    height: workspaceBounds.height,
    transform: `scale(${viewport.zoom})`,
  } as CSSProperties;
  const firstFailedCheckIndex = validation ? validation.checks.findIndex((check) => !check.pass) : -1;
  const paletteActions = createPaletteActions({
    lab,
    cliHints,
    scenarioDomain,
    runValidation: () => { void runValidation(); },
    fitTopology,
    centerTopology: () => centerTopology(),
    resetPanels,
    toggleScenarios: () => setLeftPanelOpen((current) => !current),
    selectDevice: selectDeviceId,
    openGuide: () => setGuideOpen(true),
    setCommand: (nextCommand: string) => {
      setCommand(nextCommand);
      focusCommandInput();
    },
  });
  const filteredPaletteActions = filterPaletteActions(paletteActions, paletteQuery);

  useEffect(() => {
    document.body.dataset.theme = lab.theme;
    window.localStorage.setItem("networklab-theme", lab.theme);
    window.localStorage.setItem(SESSION_KEY, JSON.stringify({
      currentScenarioId: lab.currentScenarioId,
      selectedDeviceId: lab.selectedDeviceId,
      mode: lab.mode,
    }));
  }, [lab.theme]);

  useEffect(() => {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify({
      currentScenarioId: lab.currentScenarioId,
      selectedDeviceId: lab.selectedDeviceId,
      mode: lab.mode,
    }));
  }, [lab.currentScenarioId, lab.selectedDeviceId, lab.mode]);

  useEffect(() => {
    terminalRef.current?.scrollTo({ top: terminalRef.current.scrollHeight });
  }, [lab.terminalLines]);

  useEffect(() => {
    window.localStorage.setItem(LEFT_PANEL_KEY, String(leftPanelOpen));
  }, [leftPanelOpen]);

  useEffect(() => {
    window.localStorage.setItem(PANEL_SIZE_KEY, JSON.stringify(panelSizes));
  }, [panelSizes]);

  useEffect(() => {
    function onPointerMove(event: PointerEvent) {
      const resize = resizeRef.current;
      if (!resize) return;
      const dx = event.clientX - resize.x;
      const dy = event.clientY - resize.y;
      setPanelSizes({
        left: resize.kind === "left" ? clamp(resize.sizes.left + dx, 220, 420) : resize.sizes.left,
        right: resize.kind === "right" ? clamp(resize.sizes.right - dx, 280, 520) : resize.sizes.right,
        bottom: resize.kind === "bottom" ? clamp(resize.sizes.bottom - dy, 150, Math.min(380, Math.round(window.innerHeight * 0.42))) : resize.sizes.bottom,
      });
    }
    function onPointerUp() {
      resizeRef.current = null;
      document.body.classList.remove("resizing");
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (dragFrameRef.current !== null) cancelAnimationFrame(dragFrameRef.current);
    };
  }, []);

  useEffect(() => {
    function closeMenu() {
      setAddDeviceMenu(null);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setAddDeviceMenu(null);
        setCableSourceId(null);
      }
    }
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  function mutate(mutator: (draft: LabState) => void) {
    setLab((current) => {
      const draft = deepClone(current);
      mutator(draft);
      return draft;
    });
  }

  function loadScenario(id: string) {
    const next = SCENARIO_MAP[id];
    if (!next) return;
    setValidation(null);
    setSelectedLinkId(null);
    setCableSourceId(null);
    setViewport(DEFAULT_VIEWPORT);
    setLab((current) => {
      const created = createLabState(next, current);
      created.events = current.events;
      created.progress = current.progress;
      created.theme = current.theme;
      addEvent(created, `Loaded scenario: ${next.name}`, "success");
      return created;
    });
  }

  function selectDeviceId(deviceId: string, suggestedCommand = "") {
    setSelectedLinkId(null);
    setAddDeviceMenu(null);
    setCableSourceId(null);
    if (suggestedCommand) setCommand(suggestedCommand);
    if (suggestedCommand) focusCommandInput();
    mutate((draft) => {
      const device = draft.devices[deviceId];
      if (!device) return;
      draft.selectedDeviceId = device.id;
      addEvent(draft, `Selected device: ${device.name}`);
    });
  }

  function beginResize(kind: ResizeKind, event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    resizeRef.current = { kind, x: event.clientX, y: event.clientY, sizes: panelSizes };
    document.body.classList.add("resizing");
  }

  function setZoom(nextZoom: number) {
    setViewport((current) => ({ ...current, zoom: clamp(Number(nextZoom.toFixed(2)), 0.55, 1.6) }));
  }

  function resetPanels() {
    setPanelSizes(DEFAULT_PANEL_SIZES);
    setViewport(DEFAULT_VIEWPORT);
    requestAnimationFrame(() => centerTopology(DEFAULT_VIEWPORT.zoom));
  }

  function dismissGuide() {
    window.localStorage.setItem(GUIDE_KEY, "true");
    setGuideOpen(false);
  }

  function centerTopology(nextZoom = viewport.zoom) {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const topology = computeDeviceEnvelope(Object.values(lab.devices));
    const centerX = (topology.minX + topology.maxX) / 2 - workspaceBounds.minX;
    const centerY = (topology.minY + topology.maxY) / 2 - workspaceBounds.minY;
    requestAnimationFrame(() => {
      workspace.scrollTo({
        left: Math.max(0, centerX * nextZoom - workspace.clientWidth / 2),
        top: Math.max(0, centerY * nextZoom - workspace.clientHeight / 2),
        behavior: "smooth",
      });
    });
  }

  function fitTopology() {
    const workspace = workspaceRef.current;
    const devices = Object.values(lab.devices);
    if (!workspace || !devices.length) return;
    const minX = Math.min(...devices.map((device) => device.x));
    const minY = Math.min(...devices.map((device) => device.y));
    const maxX = Math.max(...devices.map((device) => device.x + DEVICE_WIDTH));
    const maxY = Math.max(...devices.map((device) => device.y + DEVICE_MIN_HEIGHT));
    const paddedWidth = Math.max(1, maxX - minX + 120);
    const paddedHeight = Math.max(1, maxY - minY + 100);
    const nextZoom = clamp(Math.min(workspace.clientWidth / paddedWidth, workspace.clientHeight / paddedHeight), 0.55, 1.4);
    setViewport({ zoom: Number(nextZoom.toFixed(2)), x: 0, y: 0 });
    requestAnimationFrame(() => {
      workspace.scrollTo({
        left: Math.max(0, (minX - 60 - workspaceBounds.minX) * nextZoom),
        top: Math.max(0, (minY - 50 - workspaceBounds.minY) * nextZoom),
        behavior: "smooth",
      });
    });
  }

  function resetScenario() {
    const next = SCENARIO_MAP[lab.currentScenarioId];
    if (!next) return;
    setValidation(null);
    setSelectedLinkId(null);
    setCableSourceId(null);
    setViewport(DEFAULT_VIEWPORT);
    setLab((current) => {
      const created = createLabState(next, current);
      created.events = current.events;
      created.progress = current.progress;
      created.theme = current.theme;
      addTerminalLine(created, `-- Scenario reset: ${next.name} --`);
      addEvent(created, `Reset scenario: ${next.name}`, "success");
      return created;
    });
  }

  function saveProgress() {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 2, savedAt: new Date().toISOString(), lab }));
    mutate((draft) => addEvent(draft, "Progress saved to localStorage.", "success"));
  }

  function loadProgress() {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      mutate((draft) => addEvent(draft, "No saved progress found.", "warn"));
      return;
    }
    try {
      const payload = JSON.parse(raw) as { lab?: LabState; savedAt?: string };
      if (!payload.lab || !SCENARIO_MAP[payload.lab.currentScenarioId]) throw new Error("Invalid save");
      const normalizedDevices = Object.fromEntries(Object.values(payload.lab.devices || {}).map((device) => {
        const normalized = normalizeDevice(device);
        return [normalized.id, normalized];
      }));
      setLab({ ...payload.lab, devices: normalizedDevices });
      setValidation(null);
      setSelectedLinkId(null);
      setCableSourceId(null);
      setViewport(DEFAULT_VIEWPORT);
    } catch {
      mutate((draft) => addEvent(draft, "Saved progress could not be parsed.", "error"));
    }
  }

  function applyEndpointFields() {
    setValidation(null);
    mutate((draft) => {
      const device = selectedDevice(draft);
      if (!device || !(device.type === "pc" || device.type === "server")) return;
      const ip = (document.getElementById("edit-ip") as HTMLInputElement | null)?.value.trim() || "";
      const mask = (document.getElementById("edit-mask") as HTMLInputElement | null)?.value.trim() || "";
      const gateway = (document.getElementById("edit-gateway") as HTMLInputElement | null)?.value.trim() || "";
      const dns = (document.getElementById("edit-dns") as HTMLInputElement | null)?.value.trim() || "";
      if (!device.interfaces[0]) device.interfaces.push({ name: "eth0", ip: "", mask: "", up: true });
      device.interfaces[0].ip = ip;
      device.interfaces[0].mask = mask;
      device.interfaces[0].up = true;
      device.gateway = gateway;
      device.dns = dns;
      addEvent(draft, `Applied endpoint fields on ${device.name}.`, "success");
      addTerminalLine(draft, `${device.name}: fields updated.`);
    });
  }

  async function requestDhcp() {
    setValidation(null);
    await yieldToBrowser();
    mutate((draft) => {
      const device = selectedDevice(draft);
      if (!device) return;
      addTerminalOutput(draft, new Simulator(draft).renewDhcp(device.id));
    });
  }

  function updateServerServices(deviceId: string, action: ServerServiceAction) {
    setValidation(null);
    mutate((draft) => {
      const device = draft.devices[deviceId];
      if (!device || device.type !== "server") return;
      const fail = (message: string) => {
        addEvent(draft, message, "error");
        addTerminalLine(draft, `% ${message}`);
      };
      if (action.type === "toggle") {
        device.services[action.service] = action.enabled;
        addEvent(draft, `${device.name}: ${action.service.toUpperCase()} service ${action.enabled ? "enabled" : "disabled"}.`, action.enabled ? "success" : "warn");
        addTerminalLine(draft, `${device.name}: ${action.service.toUpperCase()} ${action.enabled ? "enabled" : "disabled"}.`);
        return;
      }
      if (action.type === "dhcp-save") {
        const pool = {
          ...action.pool,
          name: action.pool.name.trim() || "SERVER_POOL",
          network: action.pool.network.trim(),
          mask: action.pool.mask.trim(),
          defaultRouter: action.pool.defaultRouter.trim(),
          dnsServer: action.pool.dnsServer.trim(),
          start: action.pool.start?.trim() || "",
          end: action.pool.end?.trim() || "",
          excludedRanges: action.pool.excludedRanges || [],
        };
        if (!isValidIp(pool.network) || !isValidMask(pool.mask)) return fail("DHCP pool needs a valid network and subnet mask.");
        if (!isValidIp(pool.defaultRouter)) return fail("DHCP pool needs a valid default gateway.");
        if (!isValidIp(pool.dnsServer)) return fail("DHCP pool needs a valid DNS server.");
        if (pool.start && !isValidIp(pool.start)) return fail("DHCP pool start IP is invalid.");
        if (pool.end && !isValidIp(pool.end)) return fail("DHCP pool end IP is invalid.");
        pool.network = networkAddress(pool.network, pool.mask);
        const existingIndex = device.dhcpPools.findIndex((item) => item.name.toLowerCase() === pool.name.toLowerCase());
        if (existingIndex >= 0) device.dhcpPools[existingIndex] = pool;
        else device.dhcpPools.push(pool);
        device.services.dhcp = true;
        addEvent(draft, `${device.name}: DHCP pool ${pool.name} saved.`, "success");
        addTerminalLine(draft, `${device.name}: DHCP pool ${pool.name} saved and DHCP enabled.`);
        return;
      }
      if (action.type === "dhcp-delete") {
        device.dhcpPools = device.dhcpPools.filter((pool) => pool.name !== action.name);
        addEvent(draft, `${device.name}: DHCP pool ${action.name} deleted.`, "warn");
        addTerminalLine(draft, `${device.name}: DHCP pool ${action.name} deleted.`);
        return;
      }
      if (action.type === "dns-save") {
        const name = action.name.trim().toLowerCase();
        if (!name) return fail("DNS record needs a domain name.");
        if (!isValidIp(action.ip.trim())) return fail("DNS record needs a valid IP address.");
        device.dnsRecords[name] = action.ip.trim();
        device.services.dns = true;
        addEvent(draft, `${device.name}: DNS record ${name} saved.`, "success");
        addTerminalLine(draft, `${device.name}: DNS ${name} -> ${action.ip.trim()} saved and DNS enabled.`);
        return;
      }
      if (action.type === "dns-delete") {
        delete device.dnsRecords[action.name];
        addEvent(draft, `${device.name}: DNS record ${action.name} deleted.`, "warn");
        addTerminalLine(draft, `${device.name}: DNS record ${action.name} deleted.`);
        return;
      }
      if (action.type === "www-save") {
        device.httpContent = action.content.trim() || `Welcome to ${device.name} (simulated response).`;
        device.services.http = true;
        addEvent(draft, `${device.name}: WWW content saved.`, "success");
        addTerminalLine(draft, `${device.name}: WWW content saved and HTTP enabled.`);
        return;
      }
      if (action.type === "mail-user-save") {
        const user = action.user.trim().toLowerCase();
        if (!user || /\s/.test(user)) return fail("MAIL user must be a single mailbox name.");
        if (!device.mailboxes[user]) device.mailboxes[user] = [];
        device.services.mail = true;
        addEvent(draft, `${device.name}: MAIL mailbox ${user} ready.`, "success");
        addTerminalLine(draft, `${device.name}: MAIL mailbox ${user} ready and MAIL enabled.`);
        return;
      }
      if (action.type === "mail-clear") {
        device.mailboxes[action.user] = [];
        addEvent(draft, `${device.name}: MAIL mailbox ${action.user} cleared.`, "warn");
        addTerminalLine(draft, `${device.name}: MAIL mailbox ${action.user} cleared.`);
      }
    });
  }

  async function executeRawCommand(rawCommand: string) {
    const commands = splitCliCommands(rawCommand);
    if (!commands.length) return;
    setValidation(null);
    await yieldToBrowser();
    mutate((draft) => {
      commands.forEach((raw) => {
        const device = selectedDevice(draft);
        if (device) pushHistory(device, raw);
        if (isTerminalClearCommand(raw)) {
          draft.terminalLines = [];
          addEvent(draft, "Terminal cleared.", "info");
          return;
        }
        addTerminalLine(draft, `${cliPrompt(draft)} ${raw}`);
        addTerminalOutput(draft, runCliCommand(draft, raw));
      });
    });
  }

  async function runCommand() {
    const raw = command.trim();
    if (!raw) return;
    setCommand("");
    await executeRawCommand(raw);
  }

  async function runValidation() {
    await yieldToBrowser();
    mutate((draft) => {
      const result = validateScenario(draft);
      setValidation(result);
      addEvent(draft, `Validation complete: ${result.passed}/${result.total}.`, result.allPassed ? "success" : "warn");
    });
  }

  function onHistoryKey(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      void runCommand();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const completion = completeCliCommand(lab, command);
      if (completion.value && completion.value !== command) setCommand(completion.value);
      if (completion.message) mutate((draft) => addTerminalOutput(draft, completion.message || ""));
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const next = navigateHistory(selected, event.key === "ArrowUp" ? -1 : 1, command);
    if (next !== null) setCommand(next);
  }

  function commitDragFrame() {
    const drag = dragRef.current;
    const point = pendingDragRef.current;
    dragFrameRef.current = null;
    if (!drag || !point) return;
    pendingDragRef.current = null;
    setLab((current) => {
      const device = current.devices[drag.id];
      if (!device || (device.x === point.x && device.y === point.y)) return current;
      return {
        ...current,
        devices: {
          ...current.devices,
          [drag.id]: { ...device, x: point.x, y: point.y },
        },
      };
    });
  }

  function pointerDown(event: React.PointerEvent<HTMLButtonElement>, device: Device) {
    if (cableSourceId && event.button === 0) {
      event.preventDefault();
      event.stopPropagation();
      if (device.id !== cableSourceId) connectCable(cableSourceId, device.id);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const workspace = workspaceRef.current;
    const rect = workspace?.getBoundingClientRect();
    const scale = viewport.zoom || 1;
    const pointerX = (event.clientX - (rect?.left || 0) + (workspace?.scrollLeft || 0)) / scale + workspaceBounds.minX;
    const pointerY = (event.clientY - (rect?.top || 0) + (workspace?.scrollTop || 0)) / scale + workspaceBounds.minY;
    dragRef.current = {
      id: device.id,
      dx: pointerX - device.x,
      dy: pointerY - device.y,
    };
    setSelectedLinkId(null);
    mutate((draft) => {
      draft.selectedDeviceId = device.id;
      addEvent(draft, `Selected device: ${device.name}`);
    });
  }

  function pointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const scale = viewport.zoom || 1;
    const pointerX = (event.clientX - rect.left + event.currentTarget.scrollLeft) / scale + workspaceBounds.minX;
    const pointerY = (event.clientY - rect.top + event.currentTarget.scrollTop) / scale + workspaceBounds.minY;
    pendingDragRef.current = {
      x: Math.round(pointerX - drag.dx),
      y: Math.round(pointerY - drag.dy),
    };
    if (dragFrameRef.current === null) dragFrameRef.current = requestAnimationFrame(commitDragFrame);
  }

  function pointerUp() {
    if (dragFrameRef.current !== null) {
      cancelAnimationFrame(dragFrameRef.current);
      dragFrameRef.current = null;
    }
    commitDragFrame();
    dragRef.current = null;
    pendingDragRef.current = null;
  }

  function workspacePointFromEvent(event: React.MouseEvent<HTMLDivElement> | React.PointerEvent<HTMLDivElement>) {
    const workspace = workspaceRef.current;
    const rect = workspace?.getBoundingClientRect();
    const scale = viewport.zoom || 1;
    return {
      x: Math.round((event.clientX - (rect?.left || 0) + (workspace?.scrollLeft || 0)) / scale + workspaceBounds.minX),
      y: Math.round((event.clientY - (rect?.top || 0) + (workspace?.scrollTop || 0)) / scale + workspaceBounds.minY),
    };
  }

  function openAddDeviceMenu(event: React.MouseEvent<HTMLDivElement>) {
    const target = event.target as Element | null;
    if (target?.closest?.(".device-node, .link-hit, .context-menu")) return;
    event.preventDefault();
    const point = workspacePointFromEvent(event);
    setSelectedLinkId(null);
    setAddDeviceMenu({ clientX: event.clientX, clientY: event.clientY, x: point.x, y: point.y });
  }

  function addDeviceFromMenu(type: DeviceType) {
    if (!addDeviceMenu) return;
    const x = Math.round(addDeviceMenu.x - DEVICE_WIDTH / 2);
    const y = Math.round(addDeviceMenu.y - DEVICE_ANCHOR_Y);
    setValidation(null);
    setSelectedLinkId(null);
    setCableSourceId(null);
    mutate((draft) => {
      const device = createCanvasDevice(draft, type, x, y);
      draft.devices[device.id] = device;
      draft.selectedDeviceId = device.id;
      addEvent(draft, `Added ${device.name} to workspace.`, "success");
      addTerminalLine(draft, `${device.name}: added from canvas menu.`);
    });
    setAddDeviceMenu(null);
  }

  function addInterfaceToDevice(deviceId: string) {
    setValidation(null);
    mutate((draft) => {
      const device = draft.devices[deviceId];
      if (!device) return;
      const iface = createNextInterface(device);
      device.interfaces.push(iface);
      addEvent(draft, `Added interface ${device.name}/${iface.name}.`, "success");
      addTerminalLine(draft, `${device.name}: interface ${iface.name} added.`);
    });
  }

  function deleteDevice(deviceId: string) {
    setValidation(null);
    setSelectedLinkId(null);
    if (cableSourceId === deviceId) setCableSourceId(null);
    mutate((draft) => {
      const device = draft.devices[deviceId];
      if (!device) return;
      const removedLinks = draft.links.filter((link) => link.from === deviceId || link.to === deviceId).length;
      delete draft.devices[deviceId];
      draft.links = draft.links.filter((link) => link.from !== deviceId && link.to !== deviceId);
      if (draft.selectedDeviceId === deviceId) draft.selectedDeviceId = Object.keys(draft.devices)[0] || null;
      draft.lastFlow = null;
      addEvent(draft, `Deleted ${device.name} and ${removedLinks} cable(s).`, "warn");
      addTerminalLine(draft, `${device.name}: deleted from workspace.`);
    });
  }

  function deleteLink(linkId: string) {
    setValidation(null);
    setSelectedLinkId(null);
    mutate((draft) => {
      const link = draft.links.find((candidate) => candidate.id === linkId);
      if (!link) return;
      const from = draft.devices[link.from]?.name || link.from;
      const to = draft.devices[link.to]?.name || link.to;
      draft.links = draft.links.filter((candidate) => candidate.id !== linkId);
      draft.lastFlow = null;
      addEvent(draft, `Deleted cable ${from}/${link.fromIf} - ${to}/${link.toIf}.`, "warn");
      addTerminalLine(draft, `Cable deleted: ${from}/${link.fromIf} - ${to}/${link.toIf}.`);
    });
  }

  function startCableFrom(deviceId: string) {
    setSelectedLinkId(null);
    setCableSourceId(deviceId);
    mutate((draft) => {
      const device = draft.devices[deviceId];
      if (!device) return;
      draft.selectedDeviceId = device.id;
      addEvent(draft, `Cable start: ${device.name}. Click another device to connect.`);
    });
  }

  function connectCable(fromDeviceId: string, toDeviceId: string) {
    setValidation(null);
    setSelectedLinkId(null);
    mutate((draft) => {
      const from = draft.devices[fromDeviceId];
      const to = draft.devices[toDeviceId];
      if (!from || !to || from.id === to.id) return;
      const fromIf = ensureCableInterface(draft, from.id);
      const toIf = ensureCableInterface(draft, to.id);
      const link: Link = {
        id: nextLinkId(draft),
        from: from.id,
        to: to.id,
        fromIf,
        toIf,
      };
      draft.links.push(link);
      draft.selectedDeviceId = to.id;
      draft.lastFlow = null;
      addEvent(draft, `Connected ${from.name}/${fromIf} to ${to.name}/${toIf}.`, "success");
      addTerminalLine(draft, `Cable added: ${from.name}/${fromIf} - ${to.name}/${toIf}.`);
    });
    setCableSourceId(null);
  }

  function updateRecipe<K extends keyof RecipeOptions>(key: K, value: RecipeOptions[K]) {
    setRecipeDraft((current) => ({ ...current, [key]: value }));
  }

  async function buildRecipe() {
    await yieldToBrowser();
    const result = buildRecipeLab(recipeDraft, lab);
    if ("error" in result) {
      mutate((draft) => addEvent(draft, result.error, "error"));
      return;
    }
    setValidation(null);
    setSelectedLinkId(null);
    setCableSourceId(null);
    setViewport(DEFAULT_VIEWPORT);
    setLab(result.lab);
  }

  function applyValidationHint(label: string) {
    const target = inferDeviceForText(lab, label) || selected;
    const hintCommand = commandForValidationHint(label, target, lab);
    if (target) {
      selectDeviceId(target.id, hintCommand);
      return;
    }
    if (hintCommand) {
      setCommand(hintCommand);
      focusCommandInput();
    }
  }

  function objectiveState(index: number): ObjectiveState {
    if (!validation) return index === 0 ? "active" : "idle";
    const check = validation.checks[index];
    if (!check) return validation.allPassed ? "done" : "idle";
    if (check.pass) return "done";
    return index === firstFailedCheckIndex ? "active" : "idle";
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        void runValidation();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
        return;
      }
      if (event.key === "Escape") {
        if (paletteOpen) {
          setPaletteOpen(false);
          return;
        }
        focusCommandInput();
        return;
      }
      if (event.altKey && /^[1-9]$/.test(event.key)) {
        const scenarioIndex = Number(event.key) - 1;
        const next = SCENARIOS[scenarioIndex];
        if (next) {
          event.preventDefault();
          loadScenario(next.id);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <img className="brand-logo" src={`${import.meta.env.BASE_URL}brand/netpket-logo-text.png`} alt="Netpket" />
          <div className="subtle">{scenario.name} / {scenario.difficulty} / Score {scenarioScore}%</div>
        </div>
        <div className="status-strip" role="status">
          <span>Selected: {selected ? selected.name : "None"}</span>
          <span>Mode: {lab.mode}</span>
          <span>{lab.lastFlow ? `${lab.lastFlow.mode}: ${lab.lastFlow.success ? "success" : "blocked"}` : "Packet flow idle"}</span>
        </div>
        <div className="controls">
          <label className="mode-control">
            Mode
            <select aria-label="Mode selector" value={lab.mode} onChange={(event) => mutate((draft) => { draft.mode = event.target.value; })}>
              {MODES.map((mode) => <option key={mode}>{mode}</option>)}
            </select>
          </label>
          <button
            type="button"
            className="compact-control"
            aria-label={leftPanelOpen ? "Hide Scenarios" : "Show Scenarios"}
            aria-controls="scenario-panel"
            aria-expanded={leftPanelOpen}
            onClick={() => setLeftPanelOpen((current) => !current)}
          >
            {leftPanelOpen ? "Hide" : "Show"}
          </button>
          <button type="button" className="compact-control" onClick={() => setGuideOpen(true)}>Guide</button>
          <button type="button" className="compact-control" onClick={() => setIpTableOpen(true)}>IP Table</button>
          <label className="scenario-control">
            Scenario
            <select aria-label="Scenario selector" value={lab.currentScenarioId} onChange={(event) => loadScenario(event.target.value)}>
              {SCENARIOS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <button type="button" onClick={resetScenario}>Reset</button>
          <button type="button" onClick={saveProgress}>Save</button>
          <button type="button" onClick={loadProgress}>Load</button>
          <button type="button" aria-label="Toggle high contrast theme" onClick={() => mutate((draft) => { draft.theme = draft.theme === "dark" ? "light" : "dark"; })}>
            {lab.theme === "dark" ? "Platinum" : "Invert"}
          </button>
        </div>
      </header>

      <main className={`layout ${leftPanelOpen ? "" : "left-collapsed"}`} style={layoutStyle}>
        {!leftPanelOpen && (
          <button
            type="button"
            className="scenario-rail"
            aria-label="Show scenarios panel"
            aria-controls="scenario-panel"
            aria-expanded={leftPanelOpen}
            title="Show scenarios panel"
            onClick={() => setLeftPanelOpen(true)}
          >
            Show Scenarios
          </button>
        )}
        <aside id="scenario-panel" className="panel left-panel" hidden={!leftPanelOpen}>
          <h2 className="left-panel-title">
            <span>Scenarios</span>
            <button
              type="button"
              className="panel-title-button"
              aria-controls="scenario-panel"
              aria-expanded={leftPanelOpen}
              onClick={() => setLeftPanelOpen(false)}
            >
              Hide
            </button>
          </h2>
          <div className="scenario-list">
            {SCENARIOS.map((item) => (
              <button
                type="button"
                key={item.id}
                className={`scenario-item ${item.id === lab.currentScenarioId ? "active" : ""}`}
                onClick={() => loadScenario(item.id)}
              >
                <strong>{item.name}</strong>
                <span>{item.difficulty}</span>
                <span>{lab.progress[item.id]?.completed ? "Completed" : "Pending"}</span>
              </button>
            ))}
          </div>

          <h3>Objectives</h3>
          <div className="objective-list" role="list">
            {scenario.objectives.map((item, index) => (
              <button
                type="button"
                key={item}
                className={`objective-item ${objectiveState(index)}`}
                onClick={() => applyValidationHint(validation?.checks[index]?.label || item)}
              >
                <span>{index + 1}</span>
                {item}
              </button>
            ))}
          </div>
          <h3>Lab Flow</h3>
          <ol className="hint-list">
            <li>Configure addressing and interface state.</li>
            <li>Use CLI tests from the selected device.</li>
            <li>Validate when packet flow succeeds.</li>
          </ol>
          <RecipeBuilder
            draft={recipeDraft}
            preview={recipePreview}
            onChange={updateRecipe}
            onBuild={buildRecipe}
          />
          <h3>Why This Matters</h3>
          <p className="small-text">{scenario.why}</p>
        </aside>
        {leftPanelOpen && (
          <div className="splitter splitter-left" role="separator" aria-label="Resize scenarios panel" onPointerDown={(event) => beginResize("left", event)}>
            <button
              type="button"
              className="sidebar-toggle-grip"
              aria-label="Hide scenarios panel"
              aria-controls="scenario-panel"
              aria-expanded={leftPanelOpen}
              title="Hide scenarios panel"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => setLeftPanelOpen(false)}
            >
              Hide
            </button>
          </div>
        )}

        <section className="panel workspace-panel">
          <div className="workspace-toolbar">
            <span>Logical Workspace</span>
            <div className="toolbar-actions">
              <span>{cableSource ? `Cabling from ${cableSource.name}: click target device` : lab.lastFlow ? `Last ${lab.lastFlow.mode}: ${lab.lastFlow.success ? "success" : "blocked"}` : "No packet flow yet"}</span>
              <button type="button" onClick={fitTopology}>Fit</button>
              <button type="button" onClick={() => centerTopology()}>Center</button>
              <button type="button" aria-label="Zoom out" onClick={() => setZoom(viewport.zoom - 0.1)}>-</button>
              <span className="zoom-readout">{Math.round(viewport.zoom * 100)}%</span>
              <button type="button" aria-label="Zoom in" onClick={() => setZoom(viewport.zoom + 0.1)}>+</button>
              <button type="button" onClick={resetPanels}>Panels</button>
              <button type="button" aria-label="Open command palette" onClick={() => setPaletteOpen(true)}>Cmd K</button>
            </div>
          </div>
          <div
            className="workspace"
            ref={workspaceRef}
            onContextMenu={openAddDeviceMenu}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={pointerUp}
          >
            <div className="workspace-content" style={workspaceContentStyle}>
              <div className="workspace-canvas" style={workspaceCanvasStyle}>
                <svg
                  className="link-layer"
                  style={{ width: workspaceBounds.width, height: workspaceBounds.height }}
                  viewBox={`${workspaceBounds.minX} ${workspaceBounds.minY} ${workspaceBounds.width} ${workspaceBounds.height}`}
                  aria-label="Topology links"
                >
                  {routedLinks.map(({ link, route, fromBadge, toBadge }) => {
                    const active = lab.lastFlow?.pathLinks.includes(link.id);
                    const selectedLinkActive = selectedLinkId === link.id;
                    const routingStatus = dynamicRoutingLinkStatus(lab, link);
                    return (
                      <g key={link.id}>
                        <path
                          d={route.path}
                          className="link-hit"
                          onPointerDown={(event) => {
                            event.stopPropagation();
                            setSelectedLinkId(link.id);
                          }}
                          onClick={() => setSelectedLinkId(link.id)}
                        />
                        <path
                          d={route.path}
                          className={`link-path ${active ? "flow-link" : ""} ${selectedLinkActive ? "selected-link" : ""}`}
                        />
                        {routingStatus && (
                          <path
                            d={parallelStatusPath(route.points)}
                            className={`routing-status-link ${routingStatus}`}
                          />
                        )}
                        <g className="link-badge endpoint-label">
                          <rect x={fromBadge.x} y={fromBadge.y} width={fromBadge.width} height={fromBadge.height} />
                          <text className="link-label endpoint-label" x={fromBadge.textX} y={fromBadge.textY}>{link.fromIf}</text>
                        </g>
                        <g className="link-badge endpoint-label">
                          <rect x={toBadge.x} y={toBadge.y} width={toBadge.width} height={toBadge.height} />
                          <text className="link-label endpoint-label" x={toBadge.textX} y={toBadge.textY}>{link.toIf}</text>
                        </g>
                      </g>
                    );
                  })}
                  {packetFlowPath && lab.lastFlow && (
                    <g className={`packet-trace ${lab.lastFlow.success ? "success" : "blocked"}`} aria-label="Animated packet flow">
                      <path className="flow-route-path" d={packetFlowPath} />
                      <circle key={lab.lastFlow.id || packetFlowPath} className="packet-dot" r="6">
                        <animateMotion dur={`${Math.max(1.8, lab.lastFlow.pathLinks.length * 0.55)}s`} repeatCount="indefinite" path={packetFlowPath} />
                      </circle>
                    </g>
                  )}
                </svg>
                {Object.values(lab.devices).map((device) => {
                  const status = deviceStatus(device);
                  const active = lab.lastFlow?.pathDevices.includes(device.id);
                  const health = deviceHealth(lab, device);
                  return (
                    <button
                      type="button"
                      key={device.id}
                      className={`device-node ${selected?.id === device.id ? "selected" : ""} ${active ? "flow-node" : ""} ${cableSourceId === device.id ? "cable-source" : ""} ${cableSourceId && cableSourceId !== device.id ? "cable-target" : ""}`}
                      style={{ left: device.x - workspaceBounds.minX, top: device.y - workspaceBounds.minY }}
                      onPointerDown={(event) => pointerDown(event, device)}
                    >
                      <span className="device-title">
                        <span className={`status-dot ${status}`} />
                        <span className="device-name">{device.name}</span>
                        <span className={`issue-badge ${health.issueCount ? "bad" : "ok"}`} title={health.summary}>
                          {health.issueCount ? `!${health.issueCount}` : "OK"}
                        </span>
                      </span>
                      <span className="device-body">
                        <span className={`device-icon-frame ${device.type}`} aria-hidden="true">
                          <DeviceGlyph type={device.type} />
                        </span>
                        <span className="device-readout">
                          <span className="device-type">{device.type.toUpperCase()}</span>
                          <span className="service-lamps" aria-label={`${device.name} status lamps`}>
                            {health.lamps.map((lamp) => (
                              <span key={`${device.id}-${lamp.label}`} className={`service-lamp ${lamp.state}`} title={lamp.title}>{lamp.label}</span>
                            ))}
                          </span>
                          {device.interfaces.slice(0, 2).map((iface) => <span key={iface.name} className="if-line">{iface.name}: {iface.ip || "--"} {iface.up ? "up" : "down"}</span>)}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </section>
        <div className="splitter splitter-right" role="separator" aria-label="Resize inspector panel" onPointerDown={(event) => beginResize("right", event)} />

        <aside className="panel right-panel">
          <h2>Inspector</h2>
          {selectedLink ? (
            <LinkInspector link={selectedLink} lab={lab} onSelectDevice={selectDeviceId} onDeleteLink={deleteLink} />
          ) : !selected ? (
            <p className="empty">Select a device in the workspace.</p>
          ) : (
            <DeviceInspector
              key={selected.id}
              selected={selected}
              simulator={simulator}
              scenarioDomain={scenarioDomain}
              onApply={applyEndpointFields}
              onDhcp={requestDhcp}
              onServerServices={updateServerServices}
              onQuickCommand={executeRawCommand}
              onAddInterface={() => addInterfaceToDevice(selected.id)}
              onStartCable={() => startCableFrom(selected.id)}
              onDelete={() => deleteDevice(selected.id)}
              isCableSource={cableSourceId === selected.id}
            />
          )}
        </aside>
        <div className="splitter splitter-bottom" role="separator" aria-label="Resize lower panels" onPointerDown={(event) => beginResize("bottom", event)} />

        <section className="panel terminal-panel">
          <div className="terminal-header">
            <h2>CLI</h2>
            <span>{cliPrompt(lab)}</span>
          </div>
          <div className="terminal-history" ref={terminalRef}>
            {lab.terminalLines.map((line, index) => <div key={`${line}-${index}`} className={`terminal-line ${terminalLineClass(line)}`}>{line}</div>)}
          </div>
          <div className="terminal-input-row">
            <span>{cliPrompt(lab)}</span>
            <input
              aria-label="Command input"
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              onKeyDown={onHistoryKey}
              placeholder={selected && (selected.type === "pc" || selected.type === "server") ? "ipconfig, ping, nslookup, curl" : "en, conf t, int g0/0, show ip route"}
            />
            <button type="button" onClick={runCommand}>Run</button>
          </div>
          <div className="cli-hints" aria-label="Command hints">
            {cliErrorHints.map((hint) => (
              <button type="button" className="error-hint" key={`error-${hint}`} onClick={() => { setCommand(hint); focusCommandInput(); }}>{hint}</button>
            ))}
            {cliHints.map((hint) => (
              <button type="button" key={hint} onClick={() => { setCommand(hint); focusCommandInput(); }}>{hint}</button>
            ))}
          </div>
        </section>

        <section className="panel review-panel">
          <div className="review-header">
            <h2>Review</h2>
            <button type="button" className="btn-accent" onClick={runValidation}>Validate Scenario</button>
          </div>
          {validation ? (
            <div className="validation">
              <strong>{validation.passed}/{validation.total} checks passed</strong>
              {validation.checks.map((check) => (
                check.pass ? (
                  <div key={check.label} className="check pass">
                    <span>PASS</span>
                    <strong>{check.label}</strong>
                  </div>
                ) : (
                  <button type="button" key={check.label} className="check fail fix-check" onClick={() => applyValidationHint(check.label)}>
                    <span>FIX</span>
                    <strong>{check.label}</strong>
                    <small>{validationHintText(check.label)}</small>
                  </button>
                )
              ))}
            </div>
          ) : (
            <p className="empty">Run validation when the lab is configured.</p>
          )}
          {lab.lastFlow && (
            <div className="flow-debug">
              <h3>Packet Debug</h3>
              <strong>{lab.lastFlow.mode} {lab.lastFlow.success ? "success" : "blocked"}: {lab.lastFlow.sourceName} -&gt; {lab.lastFlow.target}</strong>
              {lab.lastFlow.steps?.length > 0 ? (
                <ol className="flow-steps">
                  {lab.lastFlow.steps.map((step, index) => (
                    <li key={`${step.kind}-${step.detail}-${index}`} className={`flow-step ${step.kind} ${step.status}`}>
                      <span>{step.label}</span>
                      <small>{step.detail}</small>
                    </li>
                  ))}
                </ol>
              ) : lab.lastFlow.reasons.length > 0 ? (
                <ol>
                  {lab.lastFlow.reasons.map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)}
                </ol>
              ) : (
                <p className="empty">No packet decisions recorded.</p>
              )}
              {lab.lastFlow.pathDevices.length > 0 && <p className="small-text">Path: {lab.lastFlow.pathDevices.map((id) => lab.devices[id]?.name || id).join(" -> ")}</p>}
            </div>
          )}
          <h3>Event Log</h3>
          <ul className="event-log">
            {lab.events.slice(-12).reverse().map((event, index) => <li key={`${event.time}-${index}`} className={event.level}>[{event.time}] {event.message}</li>)}
          </ul>
        </section>
      </main>
      {paletteOpen && (
        <CommandPalette
          query={paletteQuery}
          actions={filteredPaletteActions}
          onQuery={setPaletteQuery}
          onClose={() => setPaletteOpen(false)}
          onRun={(action) => {
            setPaletteOpen(false);
            setPaletteQuery("");
            void action.run();
          }}
        />
      )}
      {addDeviceMenu && (
        <CanvasContextMenu
          menu={addDeviceMenu}
          onClose={() => setAddDeviceMenu(null)}
          onAdd={addDeviceFromMenu}
        />
      )}
      {guideOpen && <FirstRunGuide onClose={dismissGuide} />}
      {ipTableOpen && <IpMaskTablePopup rows={IP_MASK_ROWS} onClose={() => setIpTableOpen(false)} />}
    </div>
  );
}

function focusCommandInput() {
  requestAnimationFrame(() => {
    document.querySelector<HTMLInputElement>(".terminal-input-row input")?.focus();
  });
}

function splitCliCommands(rawCommand: string): string[] {
  return rawCommand
    .split(/\r?\n|;/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function anchorForDevice(device: Device): Point {
  return { x: device.x + DEVICE_ANCHOR_X, y: device.y + DEVICE_ANCHOR_Y };
}

function linkRouteOffset(index: number): number {
  return ((index % 5) - 2) * 10;
}

function routePoints(from: Point, to: Point, offset = 0): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const midX = Math.round((from.x + to.x) / 2 + offset);
    return [from, { x: midX, y: from.y }, { x: midX, y: to.y }, to];
  }
  const midY = Math.round((from.y + to.y) / 2 + offset);
  return [from, { x: from.x, y: midY }, { x: to.x, y: midY }, to];
}

function pointsToPath(points: Point[]): string {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
}

function parallelStatusPath(points: Point[]): string {
  if (points.length < 2) return pointsToPath(points);
  const first = points[0];
  const last = points[points.length - 1];
  const offset = Math.abs(last.x - first.x) >= Math.abs(last.y - first.y)
    ? { x: 0, y: -7 }
    : { x: 7, y: 0 };
  return pointsToPath(points.map((point) => ({ x: point.x + offset.x, y: point.y + offset.y })));
}

function labelPointOutsideDevice(device: Device, toward: Point): Point {
  const anchor = anchorForDevice(device);
  const dx = toward.x - anchor.x;
  const dy = toward.y - anchor.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const direction = dx >= 0 ? 1 : -1;
    return { x: Math.round(anchor.x + direction * (DEVICE_ANCHOR_X + 42)), y: Math.round(anchor.y) };
  }
  const direction = dy >= 0 ? 1 : -1;
  return { x: Math.round(anchor.x), y: Math.round(anchor.y + direction * (DEVICE_ANCHOR_Y + 28)) };
}

function routedLink(from: Device, to: Device, index = 0): RoutedLink {
  const points = routePoints(anchorForDevice(from), anchorForDevice(to), linkRouteOffset(index));
  return {
    points,
    path: pointsToPath(points),
    fromLabel: labelPointOutsideDevice(from, points[1]),
    toLabel: labelPointOutsideDevice(to, points[points.length - 2]),
  };
}

function labelSideForDevice(device: Device, point: Point): LinkEndpointSide {
  const anchor = anchorForDevice(device);
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function layoutRoutedLinks(lab: LabState): RoutedLinkLayout[] {
  type LinkEndpointLayout = {
    layout: RoutedLinkLayout;
    endpoint: "from" | "to";
    deviceId: string;
    side: LinkEndpointSide;
    point: Point;
    toward: Point;
    label: string;
  };

  function applyEndpointPoint(endpoint: LinkEndpointLayout, point: Point) {
    endpoint.point = point;
    const badge = linkBadge(point, endpoint.label);
    if (endpoint.endpoint === "from") {
      endpoint.layout.route.fromLabel = point;
      endpoint.layout.fromBadge = badge;
    } else {
      endpoint.layout.route.toLabel = point;
      endpoint.layout.toBadge = badge;
    }
  }

  function badgeForEndpoint(endpoint: LinkEndpointLayout): LinkBadgeLayout {
    return endpoint.endpoint === "from" ? endpoint.layout.fromBadge : endpoint.layout.toBadge;
  }

  function compareEndpoints(left: LinkEndpointLayout, right: LinkEndpointLayout): number {
    return left.deviceId.localeCompare(right.deviceId)
      || left.side.localeCompare(right.side)
      || left.layout.link.id.localeCompare(right.layout.link.id)
      || left.endpoint.localeCompare(right.endpoint);
  }

  function badgeOverlap(left: LinkBadgeLayout, right: LinkBadgeLayout): { x: number; y: number } {
    return {
      x: Math.min(left.x + left.width, right.x + right.width) - Math.max(left.x, right.x),
      y: Math.min(left.y + left.height, right.y + right.height) - Math.max(left.y, right.y),
    };
  }

  function moveEndpointAwayFromCollision(left: LinkEndpointLayout, right: LinkEndpointLayout, overlap: { x: number; y: number }) {
    const leftVertical = left.side === "left" || left.side === "right";
    const rightVertical = right.side === "left" || right.side === "right";
    const order = compareEndpoints(left, right) <= 0 ? -1 : 1;

    if (leftVertical && rightVertical) {
      const shift = Math.ceil(overlap.y / 2) + 4;
      applyEndpointPoint(left, { x: left.point.x, y: left.point.y + order * shift });
      applyEndpointPoint(right, { x: right.point.x, y: right.point.y - order * shift });
      return;
    }

    if (!leftVertical && !rightVertical) {
      const shift = Math.ceil(overlap.x / 2) + 4;
      applyEndpointPoint(left, { x: left.point.x + order * shift, y: left.point.y });
      applyEndpointPoint(right, { x: right.point.x - order * shift, y: right.point.y });
      return;
    }

    const verticalEndpoint = leftVertical ? left : right;
    const horizontalEndpoint = leftVertical ? right : left;
    const verticalDirection = compareEndpoints(verticalEndpoint, horizontalEndpoint) <= 0 ? -1 : 1;
    applyEndpointPoint(verticalEndpoint, { x: verticalEndpoint.point.x, y: verticalEndpoint.point.y + verticalDirection * (Math.ceil(overlap.y / 2) + 4) });
    applyEndpointPoint(horizontalEndpoint, { x: horizontalEndpoint.point.x - verticalDirection * (Math.ceil(overlap.x / 2) + 4), y: horizontalEndpoint.point.y });
  }

  function resolveBadgeCollisions() {
    for (let pass = 0; pass < 6; pass += 1) {
      let moved = false;
      const ordered = endpoints.slice().sort(compareEndpoints);
      for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
          const left = ordered[leftIndex];
          const right = ordered[rightIndex];
          const overlap = badgeOverlap(badgeForEndpoint(left), badgeForEndpoint(right));
          if (overlap.x > 1 && overlap.y > 1) {
            moveEndpointAwayFromCollision(left, right, overlap);
            moved = true;
          }
        }
      }
      if (!moved) return;
    }
  }

  const endpoints: LinkEndpointLayout[] = [];
  const layouts = lab.links.flatMap((link, index) => {
    const from = lab.devices[link.from];
    const to = lab.devices[link.to];
    if (!from || !to) return [];

    const route = routedLink(from, to, index);
    const layout: RoutedLinkLayout = {
      link,
      route,
      fromBadge: linkBadge(route.fromLabel, link.fromIf),
      toBadge: linkBadge(route.toLabel, link.toIf),
    };

    endpoints.push({
      layout,
      endpoint: "from",
      deviceId: from.id,
      side: labelSideForDevice(from, route.fromLabel),
      point: route.fromLabel,
      toward: route.points[1],
      label: link.fromIf,
    });
    endpoints.push({
      layout,
      endpoint: "to",
      deviceId: to.id,
      side: labelSideForDevice(to, route.toLabel),
      point: route.toLabel,
      toward: route.points[route.points.length - 2],
      label: link.toIf,
    });

    return [layout];
  });

  const groups = new Map<string, LinkEndpointLayout[]>();
  endpoints.forEach((endpoint) => {
    const groupKey = `${endpoint.deviceId}:${endpoint.side}`;
    groups.set(groupKey, [...(groups.get(groupKey) || []), endpoint]);
  });

  groups.forEach((group) => {
    if (group.length < 2) return;

    const verticalStack = group[0].side === "left" || group[0].side === "right";
    const spacing = verticalStack
      ? Math.max(...group.map((endpoint) => linkBadge(endpoint.point, endpoint.label).height)) + 6
      : Math.max(...group.map((endpoint) => linkBadge(endpoint.point, endpoint.label).width)) + 6;
    const center = (group.length - 1) / 2;
    const sorted = group.slice().sort((left, right) => {
      const leftSort = verticalStack ? left.toward.y : left.toward.x;
      const rightSort = verticalStack ? right.toward.y : right.toward.x;
      return leftSort - rightSort || left.layout.link.id.localeCompare(right.layout.link.id);
    });

    sorted.forEach((endpoint, endpointIndex) => {
      const offset = Math.round((endpointIndex - center) * spacing);
      const point = verticalStack
        ? { x: endpoint.point.x, y: endpoint.point.y + offset }
        : { x: endpoint.point.x + offset, y: endpoint.point.y };
      applyEndpointPoint(endpoint, point);
    });
  });

  resolveBadgeCollisions();

  return layouts;
}

function linkBadge(point: Point, label: string) {
  const width = Math.max(34, label.length * 7 + 14);
  const height = 18;
  return {
    x: Math.round(point.x - width / 2),
    y: Math.round(point.y - height / 2),
    width,
    height,
    textX: Math.round(point.x),
    textY: Math.round(point.y),
  };
}

function flowPathForLab(lab: LabState): string {
  const flow = lab.lastFlow;
  if (!flow?.pathLinks.length || flow.pathDevices.length < 2) return "";
  const pathParts: string[] = [];
  flow.pathLinks.forEach((linkId, index) => {
    const link = lab.links.find((candidate) => candidate.id === linkId);
    if (!link) return;
    const fromId = flow.pathDevices[index];
    const toId = flow.pathDevices[index + 1];
    const from = lab.devices[fromId] || lab.devices[link.from];
    const to = lab.devices[toId] || lab.devices[link.to];
    if (!from || !to) return;
    const linkIndex = Math.max(0, lab.links.findIndex((candidate) => candidate.id === link.id));
    const points = routePoints(anchorForDevice(from), anchorForDevice(to), linkRouteOffset(linkIndex));
    points.forEach((point, pointIndex) => {
      if (!pathParts.length) pathParts.push(`M ${point.x} ${point.y}`);
      else if (pointIndex > 0) pathParts.push(`L ${point.x} ${point.y}`);
    });
  });
  return pathParts.join(" ");
}

function terminalLineClass(line: string): string {
  const lower = line.toLowerCase();
  if (line.startsWith("%") || /\b(unknown|failed|unreachable|invalid|missing|deny|drop|blocked|exceeded)\b/i.test(line)) return "error";
  if (/^(possible commands|ios-like commands|pc\/server commands|decision ladder|path:)/i.test(line)) return "help";
  if (/^(reply from|trace complete|http\/1\.1 200)|\b(success|complete|assigned|acquired|\[ok\])\b/i.test(line)) return "success";
  if (/^[A-Za-z][\w-]*(?:\([^)]*\))?[#>]\s/.test(line)) return "command";
  return "output";
}

function latestTerminalError(lab: LabState): string {
  return [...lab.terminalLines].reverse().find((line) => terminalLineClass(line) === "error") || "";
}

function commandHintsForLatestError(lab: LabState, selected: Device | null): string[] {
  const error = latestTerminalError(lab).toLowerCase();
  if (!error || !selected) return [];
  const prefix = selected.type === "router" || selected.type === "switch" ? commandPrefix(selected) : "";
  const firstInterface = selected.interfaces[0]?.name || "g0/0";
  if (error.includes("requires privileged")) return ["enable"];
  if (error.includes("configuration mode require")) return ["do show ip interface brief", "end"];
  if (error.includes("unknown interface")) return [`${prefix}show ip interface brief`, `interface ${firstInterface}`];
  if (error.includes("invalid ip") || error.includes("invalid subnet")) return [isEndpointDevice(selected) ? "ipconfig" : `${prefix}show ip interface brief`];
  if (error.includes("route missing") || error.includes("gateway")) return [isEndpointDevice(selected) ? "ipconfig" : `${prefix}show ip route`];
  if (error.includes("acl")) return [`${prefix}show access-lists`, `${prefix}show running-config`];
  if (error.includes("nat")) return [`${prefix}show ip nat translations`, `${prefix}show running-config`];
  if (error.includes("incomplete")) return ["?", "help"];
  if (error.includes("unknown command")) return ["?", "help"];
  return [];
}

function FirstRunGuide({ onClose }: { onClose: () => void }) {
  const steps = [
    { title: "1. Choose Scenario", detail: "Pick a lab or Blank Workspace." },
    { title: "2. Click Device", detail: "Inspector and CLI follow the selected device." },
    { title: "3. Type Command", detail: "Use IOS-like CLI, Tab, ?, or multi-command paste." },
    { title: "4. Validate", detail: "Run checks and inspect Packet Debug." },
  ];
  return (
    <div className="guide-backdrop" onPointerDown={onClose}>
      <section className="first-run-guide" role="dialog" aria-modal="true" aria-label="Netpket Guide" onPointerDown={(event) => event.stopPropagation()}>
        <div className="guide-title">
          <strong>Netpket Guide</strong>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <div className="guide-steps">
          {steps.map((step) => (
            <div key={step.title} className="guide-step">
              <strong>{step.title}</strong>
              <span>{step.detail}</span>
            </div>
          ))}
        </div>
        <button type="button" className="btn-accent" onClick={onClose}>Start Lab</button>
      </section>
    </div>
  );
}

function IpMaskTablePopup({ rows, onClose }: { rows: IpMaskRow[]; onClose: () => void }) {
  return (
    <div className="guide-backdrop" onPointerDown={onClose}>
      <section className="ip-table-popup" role="dialog" aria-modal="true" aria-label="IP mask address table" onPointerDown={(event) => event.stopPropagation()}>
        <div className="guide-title">
          <strong>IP Mask Table</strong>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <div className="ip-table-wrap">
          <table className="ip-info-table">
            <thead>
              <tr>
                <th>Mask / Prefix</th>
                <th>Usable host range</th>
                <th>Usable hosts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.mask}/${row.prefix}`}>
                  <td>{row.mask} / {row.prefix}</td>
                  <td>{row.hostRangeStart} - {row.hostRangeEnd}</td>
                  <td>{row.availableHosts} addresses available</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function usableHostCountForPrefix(prefix: number): number {
  if (prefix === 31) return 2;
  if (prefix === 32) return 1;
  return Math.max(0, (2 ** (32 - prefix)) - 2);
}

function deviceTypeLabel(type: DeviceType): string {
  if (type === "pc") return "PC";
  if (type === "switch") return "Switch";
  if (type === "server") return "Server";
  if (type === "cloud") return "Cloud";
  return "Router";
}

function deviceIdPrefix(type: DeviceType): string {
  if (type === "router") return "r";
  if (type === "switch") return "sw";
  if (type === "server") return "srv";
  if (type === "cloud") return "cloud";
  return "pc";
}

function nextDeviceNumber(lab: LabState, type: DeviceType): number {
  const prefix = deviceIdPrefix(type);
  let max = 0;
  Object.values(lab.devices).forEach((device) => {
    const match = device.id.toLowerCase().match(new RegExp(`^${prefix}(\\d+)$`));
    if (match) max = Math.max(max, Number(match[1]));
  });
  return max + 1;
}

function defaultInterfacesForType(type: DeviceType) {
  if (type === "router") return [{ name: "g0/0", up: false }, { name: "g0/1", up: false }];
  if (type === "switch") return [
    { name: "fa0/1", up: true },
    { name: "fa0/2", up: true },
    { name: "fa0/3", up: true },
    { name: "fa0/4", up: true },
  ];
  if (type === "cloud") return [{ name: "wan0", up: true }, { name: "lan0", up: true }];
  return [{ name: "eth0", up: true }];
}

function nextLinkId(lab: LabState): string {
  const used = new Set(lab.links.map((link) => link.id));
  let index = lab.links.length + 1;
  while (used.has(`l${index}`)) index += 1;
  return `l${index}`;
}

function interfaceNamePattern(type: DeviceType): { prefix: string; start: number; pattern: RegExp } {
  if (type === "router") return { prefix: "g0/", start: 0, pattern: /^g0\/(\d+)$/i };
  if (type === "switch") return { prefix: "fa0/", start: 1, pattern: /^fa0\/(\d+)$/i };
  if (type === "cloud") return { prefix: "wan", start: 0, pattern: /^wan(\d+)$/i };
  return { prefix: "eth", start: 0, pattern: /^eth(\d+)$/i };
}

function createNextInterface(device: Device): NetworkInterface {
  const { prefix, start, pattern } = interfaceNamePattern(device.type);
  let max = start - 1;
  device.interfaces.forEach((iface) => {
    const match = iface.name.match(pattern);
    if (match) max = Math.max(max, Number(match[1]));
  });
  return {
    name: `${prefix}${Math.max(start, max + 1)}`,
    ip: "",
    mask: "",
    up: device.type !== "router",
    natRole: null,
    aclIn: null,
    aclOut: null,
    description: "",
    helperAddress: "",
    servicePolicyIn: "",
    servicePolicyOut: "",
  };
}

function linkUsesInterface(link: Link, deviceId: string, interfaceName: string): boolean {
  return (link.from === deviceId && link.fromIf === interfaceName) || (link.to === deviceId && link.toIf === interfaceName);
}

function ensureCableInterface(lab: LabState, deviceId: string): string {
  const device = lab.devices[deviceId];
  if (!device) return "";
  const free = device.interfaces.find((iface) => !lab.links.some((link) => linkUsesInterface(link, deviceId, iface.name)));
  if (free) return free.name;
  const next = createNextInterface(device);
  device.interfaces.push(next);
  addEvent(lab, `Auto-added ${device.name}/${next.name} for cabling.`, "success");
  return next.name;
}

function createCanvasDevice(lab: LabState, type: DeviceType, x: number, y: number): Device {
  const number = nextDeviceNumber(lab, type);
  const prefix = deviceIdPrefix(type);
  const id = `${prefix}${number}`;
  const name = type === "router"
    ? `R${number}`
    : type === "switch"
      ? `Switch${number}`
      : type === "pc"
        ? `PC${number}`
        : type === "server"
          ? `Server${number}`
          : `Cloud${number}`;
  return normalizeDevice({
    id,
    name,
    type,
    x,
    y,
    interfaces: defaultInterfacesForType(type),
    gateway: "",
    dns: "",
    services: { dhcp: false, dns: false, http: false, mail: false },
  });
}

function CanvasContextMenu({
  menu,
  onClose,
  onAdd,
}: {
  menu: NonNullable<AddDeviceMenu>;
  onClose: () => void;
  onAdd: (type: DeviceType) => void;
}) {
  return (
    <div
      className="context-menu"
      role="menu"
      aria-label="Add device"
      style={{ left: menu.clientX, top: menu.clientY }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div className="context-menu-title">Add Device</div>
      {ADD_DEVICE_TYPES.map((type) => (
        <button type="button" role="menuitem" key={type} onClick={() => onAdd(type)}>
          <span className={`menu-icon ${type}`} aria-hidden="true"><DeviceGlyph type={type} /></span>
          <span>{deviceTypeLabel(type)}</span>
        </button>
      ))}
      <button type="button" role="menuitem" onClick={onClose}>Close</button>
    </div>
  );
}

function DeviceGlyph({ type }: { type: Device["type"] }) {
  if (type === "pc") {
    return (
      <svg className="device-glyph" viewBox="0 0 64 54" focusable="false">
        <rect x="9" y="7" width="39" height="27" />
        <rect x="13" y="11" width="31" height="19" className="glyph-screen" />
        <rect x="22" y="35" width="12" height="6" />
        <rect x="16" y="42" width="24" height="5" />
        <rect x="50" y="16" width="8" height="26" />
        <line x1="52" y1="21" x2="56" y2="21" />
        <text x="28" y="25">PC</text>
      </svg>
    );
  }
  if (type === "switch") {
    return (
      <svg className="device-glyph" viewBox="0 0 64 54" focusable="false">
        <rect x="6" y="15" width="52" height="24" />
        <line x1="10" y1="22" x2="54" y2="22" />
        {[12, 21, 30, 39, 48].map((x) => <rect key={x} x={x} y="28" width="6" height="5" />)}
        <path d="M17 14v-5h30v5" />
        <text x="32" y="23">SW</text>
      </svg>
    );
  }
  if (type === "server") {
    return (
      <svg className="device-glyph" viewBox="0 0 64 54" focusable="false">
        <rect x="16" y="6" width="32" height="42" />
        <line x1="16" y1="18" x2="48" y2="18" />
        <line x1="16" y1="30" x2="48" y2="30" />
        <line x1="16" y1="42" x2="48" y2="42" />
        <circle cx="23" cy="13" r="2" />
        <circle cx="23" cy="25" r="2" />
        <circle cx="23" cy="37" r="2" />
        <text x="35" y="28">SRV</text>
      </svg>
    );
  }
  if (type === "cloud") {
    return (
      <svg className="device-glyph" viewBox="0 0 64 54" focusable="false">
        <path d="M19 38h27c7 0 11-4 11-10 0-5-4-9-10-9-2-7-8-11-16-9-5 1-9 5-11 10-8 0-13 4-13 10 0 5 5 8 12 8Z" />
        <line x1="18" y1="38" x2="48" y2="38" />
        <text x="32" y="30">WAN</text>
      </svg>
    );
  }
  return (
    <svg className="device-glyph" viewBox="0 0 64 54" focusable="false">
      <ellipse cx="32" cy="27" rx="25" ry="16" />
      <path d="M21 27h22" />
      <path d="M32 16v22" />
      <path d="M23 20l-7 7 7 7" />
      <path d="M41 20l7 7-7 7" />
      <path d="M25 18l7-6 7 6" />
      <path d="M25 36l7 6 7-6" />
      <text x="32" y="31">R</text>
    </svg>
  );
}

function isEndpointDevice(device: Device): boolean {
  return device.type === "pc" || device.type === "server";
}

function commandPrefix(device: Device): string {
  return ["config", "interface", "dhcp", "acl", "routing", "class-map", "policy-map"].includes(device.cli.mode) ? "do " : "";
}

function commandForInterfaceInspection(device: Device, interfaceName: string): string {
  if (isEndpointDevice(device)) return "ipconfig";
  return `${commandPrefix(device)}show running-config interface ${interfaceName}`;
}

function scenarioDomainForLab(lab: LabState): string {
  return DOMAIN_BY_SCENARIO[lab.currentScenarioId] || "";
}

function inferDeviceForText(lab: LabState, text: string): Device | null {
  const normalized = text.toLowerCase().replace(/\s+/g, "");
  const devices = Object.values(lab.devices);
  const direct = devices.find((device) => {
    const id = device.id.toLowerCase().replace(/\s+/g, "");
    const name = device.name.toLowerCase().replace(/\s+/g, "");
    return normalized.includes(id) || normalized.includes(name);
  });
  if (direct) return direct;
  if (normalized.includes("bothpcs") || normalized.includes("pcdefault") || normalized.includes("pcandrouter")) {
    return lab.devices.pc1 || devices.find(isEndpointDevice) || null;
  }
  if (normalized.includes("router") || normalized.includes("nat") || normalized.includes("acl") || normalized.includes("route")) {
    return devices.find((device) => device.type === "router") || null;
  }
  if (normalized.includes("dhcpclient")) return devices.find((device) => device.name.toLowerCase().includes("dhcp")) || null;
  return null;
}

function commandForValidationHint(label: string, target: Device | null, lab: LabState): string {
  const lower = label.toLowerCase();
  const domain = scenarioDomainForLab(lab);
  if (!target) return lower.includes("validate") ? "" : "help";
  if (isEndpointDevice(target)) {
    if (lower.includes("lease") || lower.includes("dhcp")) return "ipconfig /renew";
    if (lower.includes("dns") || lower.includes("resolve") || lower.includes("nslookup")) return `nslookup ${domain || "<domain>"}`;
    if (lower.includes("curl") || lower.includes("http") || lower.includes("web") || lower.includes("opens")) return `curl ${domain || "<domain-or-ip>"}`;
    if (lower.includes("ping") || lower.includes("reach") || lower.includes("connect")) return `ping ${target.gateway || "<ip>"}`;
    return "ipconfig";
  }
  const prefix = commandPrefix(target);
  if (lower.includes("acl") || lower.includes("policy") || lower.includes("deny") || lower.includes("permit")) return `${prefix}show access-lists`;
  if (lower.includes("nat") || lower.includes("pat")) return `${prefix}show ip nat translations`;
  if (lower.includes("dhcp")) return `${prefix}show running-config`;
  if (lower.includes("route")) return `${prefix}show ip route`;
  if (lower.includes("interface") || lower.includes("address") || lower.includes("g0/") || lower.includes("gateway")) return `${prefix}show ip interface brief`;
  return `${prefix}show running-config`;
}

function validationHintText(label: string): string {
  const lower = label.toLowerCase();
  if (lower.includes("dhcp") || lower.includes("lease")) return "Selects the likely DHCP device and fills a DHCP check command.";
  if (lower.includes("dns") || lower.includes("resolve")) return "Selects the likely client/server and fills a DNS test command.";
  if (lower.includes("acl") || lower.includes("policy")) return "Selects the likely router and fills an ACL inspection command.";
  if (lower.includes("nat") || lower.includes("pat")) return "Selects the NAT router and fills a NAT inspection command.";
  if (lower.includes("route")) return "Selects the likely router and fills a route table command.";
  return "Selects the likely device and fills the next useful inspection command.";
}

function deviceHealth(lab: LabState, device: Device): { issueCount: number; summary: string; lamps: ServiceLamp[] } {
  const lamps: ServiceLamp[] = [];
  const allDevices = Object.values(lab.devices);
  const labHasDhcp = allDevices.some((item) => item.services.dhcp || item.dhcpPools.length > 0);
  const labHasDns = allDevices.some((item) => item.services.dns || Object.keys(item.dnsRecords).length > 0);
  const interfaces = device.interfaces;
  const upInterfaces = interfaces.filter((iface) => iface.up);
  const addressedInterfaces = interfaces.filter((iface) => iface.up && iface.ip && iface.mask);
  const endpoint = isEndpointDevice(device);

  function add(label: string, state: LampState, title: string) {
    lamps.push({ label, state, title });
  }

  if (!interfaces.length) {
    add("IF", "bad", "No interfaces exist on this device.");
  } else if (device.type === "switch") {
    add("IF", upInterfaces.length === interfaces.length ? "ok" : "bad", `${upInterfaces.length}/${interfaces.length} switch ports are up.`);
  } else {
    const state = addressedInterfaces.length === interfaces.length ? "ok" : addressedInterfaces.length > 0 ? "warn" : "bad";
    add("IF", state, `${addressedInterfaces.length}/${interfaces.length} interfaces are addressed and up.`);
  }

  if (endpoint) {
    const primary = interfaces[0];
    add("ADDR", primary?.ip && primary.mask && primary.up ? "ok" : "bad", primary?.ip ? `${primary.ip} / ${primary.mask || "no mask"}` : "Endpoint has no usable address.");
    if (primary?.ip && primary.mask && device.gateway) {
      add("GW", ipInSubnet(device.gateway, primary.ip, primary.mask) ? "ok" : "bad", `${device.gateway} ${ipInSubnet(device.gateway, primary.ip, primary.mask) ? "is" : "is not"} inside the endpoint subnet.`);
    } else {
      add("GW", "bad", "Default gateway is missing.");
    }
    if (labHasDhcp && device.type === "pc") {
      add("DHCP", primary?.ip && device.gateway ? "ok" : "warn", primary?.ip && device.gateway ? "Endpoint has usable addressing." : "Endpoint is waiting for DHCP or static addressing.");
    }
    if (labHasDns && !device.services.dns && device.type === "pc") {
      const dnsServer = allDevices.find((candidate) => candidate.services.dns && candidate.interfaces.some((iface) => iface.ip === device.dns));
      add("DNS", device.dns ? (dnsServer ? "ok" : "warn") : "bad", device.dns ? `${device.dns}${dnsServer ? ` on ${dnsServer.name}` : " is set but no matching DNS service is visible."}` : "DNS server is missing.");
    }
  }

  if (device.services.dhcp || device.dhcpPools.length > 0) {
    const completePools = device.dhcpPools.filter((pool) => pool.network && pool.mask && pool.defaultRouter && pool.dnsServer);
    add("DHCP", completePools.length === device.dhcpPools.length && completePools.length > 0 ? "ok" : "warn", `${completePools.length}/${device.dhcpPools.length} DHCP pools are complete. ${device.dhcpBindings.length} active binding(s).`);
  }

  if (device.services.dns || Object.keys(device.dnsRecords).length > 0) {
    const recordCount = Object.keys(device.dnsRecords).length;
    add("DNS", device.services.dns && recordCount > 0 ? "ok" : "warn", device.services.dns ? `${recordCount} DNS record(s) configured.` : "DNS records exist but DNS service is disabled.");
  }

  if (device.services.http) {
    add("WEB", addressedInterfaces.length > 0 ? "ok" : "bad", addressedInterfaces.length > 0 ? "HTTP service has a reachable interface." : "HTTP service has no addressed up interface.");
  }

  if (device.services.mail) {
    const mailboxCount = Object.values(device.mailboxes).reduce((total, messages) => total + messages.length, 0);
    add("MAIL", addressedInterfaces.length > 0 ? "ok" : "bad", addressedInterfaces.length > 0 ? `SMTP service enabled. ${mailboxCount} queued message(s).` : "Mail service has no addressed up interface.");
  }

  const natRoles = interfaces.filter((iface) => iface.natRole).length;
  if (natRoles || device.nat.overloadRules.length || device.nat.translations.length) {
    const state = natRoles >= 2 && device.nat.overloadRules.length > 0 ? "ok" : "warn";
    add("NAT", state, `${natRoles} NAT role interface(s), ${device.nat.overloadRules.length} overload rule(s), ${device.nat.translations.length} translation(s).`);
  }

  const aclNames = Object.keys(device.acls);
  const appliedAcls = interfaces.filter((iface) => iface.aclIn || iface.aclOut).length;
  if (aclNames.length || appliedAcls) {
    const entries = aclNames.reduce((total, name) => total + device.acls[name].entries.length, 0);
    const state = entries > 0 && appliedAcls > 0 ? "ok" : entries > 0 ? "warn" : "bad";
    add("ACL", state, `${entries} ACL rule(s), ${appliedAcls} applied interface direction(s).`);
  }

  if (device.type === "router" || device.type === "cloud") {
    const dynamicNetworks = device.dynamicRouting.reduce((total, process) => total + process.networks.length, 0);
    add("RT", device.staticRoutes.length || dynamicNetworks ? "ok" : "off", `${device.staticRoutes.length} static route(s), ${dynamicNetworks} dynamic network statement(s).`);
  }

  if (device.qos.enabled || Object.keys(device.qos.classMaps).length || Object.keys(device.qos.policyMaps).length) {
    const appliedPolicies = interfaces.filter((iface) => iface.servicePolicyIn || iface.servicePolicyOut).length;
    add("QOS", device.qos.enabled && appliedPolicies ? "ok" : "warn", `${Object.keys(device.qos.classMaps).length} class-map(s), ${Object.keys(device.qos.policyMaps).length} policy-map(s), ${appliedPolicies} interface policy attachment(s).`);
  }

  const issues = lamps.filter((lamp) => lamp.state === "warn" || lamp.state === "bad");
  return {
    issueCount: issues.length,
    summary: issues.length ? issues.map((lamp) => `${lamp.label}: ${lamp.title}`).join("\n") : "No obvious problems on tracked services.",
    lamps,
  };
}

function createPaletteActions({
  lab,
  cliHints,
  scenarioDomain,
  runValidation,
  fitTopology,
  centerTopology,
  resetPanels,
  toggleScenarios,
  selectDevice,
  openGuide,
  setCommand,
}: {
  lab: LabState;
  cliHints: string[];
  scenarioDomain: string;
  runValidation: () => void;
  fitTopology: () => void;
  centerTopology: () => void;
  resetPanels: () => void;
  toggleScenarios: () => void;
  selectDevice: (deviceId: string, suggestedCommand?: string) => void;
  openGuide: () => void;
  setCommand: (command: string) => void;
}): PaletteAction[] {
  const actions: PaletteAction[] = [
    { id: "validate", title: "Validate scenario", detail: "Run all checks and show fix hints.", run: runValidation },
    { id: "fit", title: "Fit topology", detail: "Zoom and scroll the topology into view.", run: fitTopology },
    { id: "center", title: "Center workspace", detail: "Center the logical workspace.", run: centerTopology },
    { id: "panels", title: "Reset panels", detail: "Restore panel widths, terminal height, and zoom.", run: resetPanels },
    { id: "scenarios", title: "Toggle scenarios panel", detail: "Show or hide the left scenario panel.", run: toggleScenarios },
    { id: "guide", title: "Open guide", detail: "Show the four-step first-run workflow.", run: openGuide },
  ];
  if (scenarioDomain) {
    actions.push({ id: "dns-domain", title: `Fill nslookup ${scenarioDomain}`, detail: "Prepare a DNS test in the CLI.", run: () => setCommand(`nslookup ${scenarioDomain}`) });
    actions.push({ id: "curl-domain", title: `Fill curl ${scenarioDomain}`, detail: "Prepare an HTTP test in the CLI.", run: () => setCommand(`curl ${scenarioDomain}`) });
  }
  Object.values(lab.devices)
    .sort((left, right) => left.name.localeCompare(right.name))
    .forEach((device) => {
      actions.push({
        id: `device-${device.id}`,
        title: `Select ${device.name}`,
        detail: `${device.type} inspector and CLI prompt`,
        run: () => selectDevice(device.id),
      });
    });
  cliHints.forEach((hint) => {
    actions.push({ id: `hint-${hint}`, title: `Fill command: ${hint}`, detail: "Use current CLI context.", run: () => setCommand(hint) });
  });
  return actions;
}

function filterPaletteActions(actions: PaletteAction[], query: string): PaletteAction[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return actions.slice(0, 14);
  return actions.filter((action) => `${action.title} ${action.detail}`.toLowerCase().includes(normalized)).slice(0, 14);
}

function LinkInspector({
  link,
  lab,
  onSelectDevice,
  onDeleteLink,
}: {
  link: Link;
  lab: LabState;
  onSelectDevice: (deviceId: string, suggestedCommand?: string) => void;
  onDeleteLink: (linkId: string) => void;
}) {
  const from = lab.devices[link.from];
  const to = lab.devices[link.to];
  if (!from || !to) return <p className="empty">Selected link no longer exists.</p>;
  const fromIface = getInterface(from, link.fromIf);
  const toIface = getInterface(to, link.toIf);
  const up = Boolean((!fromIface || fromIface.up) && (!toIface || toIface.up));
  return (
    <div className="link-inspector">
      <div className="chips">
        <span>link</span>
        <span>{up ? "up" : "blocked"}</span>
      </div>
      <pre className="prebox">
{[
  `${from.name} ${link.fromIf}: ${fromIface ? formatInterface(fromIface) : "interface missing"}`,
  `${to.name} ${link.toIf}: ${toIface ? formatInterface(toIface) : "interface missing"}`,
].join("\n")}
      </pre>
      <h3>Endpoints</h3>
      <div className="link-endpoints">
        <button type="button" onClick={() => onSelectDevice(from.id, commandForInterfaceInspection(from, link.fromIf))}>
          <strong>{from.name}</strong>
          <span>{link.fromIf}</span>
        </button>
        <button type="button" onClick={() => onSelectDevice(to.id, commandForInterfaceInspection(to, link.toIf))}>
          <strong>{to.name}</strong>
          <span>{link.toIf}</span>
        </button>
      </div>
      <div className="button-row">
        <button type="button" className="danger-button" onClick={() => onDeleteLink(link.id)}>Delete Cable</button>
      </div>
      <h3>What to Check</h3>
      <ul className="hint-list">
        <li>Both endpoint interfaces should be up.</li>
        <li>Router links need addresses in matching subnets.</li>
        <li>Switch links usually only need the connected port to stay up.</li>
      </ul>
    </div>
  );
}

function CommandPalette({
  query,
  actions,
  onQuery,
  onClose,
  onRun,
}: {
  query: string;
  actions: PaletteAction[];
  onQuery: (value: string) => void;
  onClose: () => void;
  onRun: (action: PaletteAction) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  return (
    <div className="palette-backdrop" onPointerDown={onClose}>
      <section className="command-palette" aria-label="Command palette" onPointerDown={(event) => event.stopPropagation()}>
        <div className="palette-title">
          <strong>Command Palette</strong>
          <button type="button" onClick={onClose}>Close</button>
        </div>
        <input
          ref={inputRef}
          aria-label="Command palette search"
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onClose();
            if (event.key === "Enter" && actions[0]) onRun(actions[0]);
          }}
          placeholder="validate, fit, select R1, dns..."
        />
        <div className="palette-list">
          {actions.length ? actions.map((action) => (
            <button type="button" key={action.id} onClick={() => onRun(action)}>
              <strong>{action.title}</strong>
              <span>{action.detail}</span>
            </button>
          )) : <p className="empty">No actions match.</p>}
        </div>
      </section>
    </div>
  );
}

function RecipeBuilder({
  draft,
  preview,
  onChange,
  onBuild,
}: {
  draft: RecipeOptions;
  preview: RecipePreview;
  onChange: <K extends keyof RecipeOptions>(key: K, value: RecipeOptions[K]) => void;
  onBuild: () => void | Promise<void>;
}) {
  return (
    <section className="recipe-builder" aria-label="Topology Recipe Builder">
      <h3>Recipe Builder</h3>
      <div className="recipe-grid">
        <label>Routers<input aria-label="Recipe router count" type="number" min={2} max={6} value={draft.routerCount} onChange={(event) => onChange("routerCount", Number(event.target.value))} /></label>
        <label>WAN Pattern<input aria-label="Inner address pattern" value={draft.innerPattern} onChange={(event) => onChange("innerPattern", event.target.value)} /></label>
        <label>WAN Mask<input aria-label="Inner mask" value={draft.innerMask} onChange={(event) => onChange("innerMask", event.target.value)} /></label>
        <label>LAN Pattern<input aria-label="Outer address pattern" value={draft.outerPattern} onChange={(event) => onChange("outerPattern", event.target.value)} /></label>
        <label>LAN Mask<input aria-label="Outer mask" value={draft.outerMask} onChange={(event) => onChange("outerMask", event.target.value)} /></label>
      </div>
      <div className="recipe-options">
        <label><input type="checkbox" checked={draft.autoNoShutdown} onChange={(event) => onChange("autoNoShutdown", event.target.checked)} /> no shutdown</label>
        <label><input type="checkbox" checked={draft.staticRoutes} onChange={(event) => onChange("staticRoutes", event.target.checked)} /> static routes</label>
      </div>
      <pre className="recipe-preview">
{[
  "Inner links:",
  ...(preview.innerLinks.length ? preview.innerLinks.map((link) => `${link.label}: ${link.leftIp} - ${link.rightIp} /${maskToPrefix(link.mask)}`) : ["none"]),
  "Outer LANs:",
  ...(preview.lans.length ? preview.lans.map((lan) => `${lan.label}: gateway ${lan.gatewayIp}, PC ${lan.pcIp}, ${lan.network}/${maskToPrefix(lan.mask)}`) : ["none"]),
].join("\n")}
      </pre>
      {preview.errors.length > 0 && <ul className="warning-list error-list">{preview.errors.map((error) => <li key={error}>{error}</li>)}</ul>}
      {preview.warnings.length > 0 && <ul className="warning-list">{preview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      <button type="button" className="btn-accent" onClick={() => { void onBuild(); }} disabled={preview.errors.length > 0}>Build Recipe Lab</button>
    </section>
  );
}

function DeviceInspector({
  selected,
  simulator,
  scenarioDomain,
  onApply,
  onDhcp,
  onServerServices,
  onQuickCommand,
  onAddInterface,
  onStartCable,
  onDelete,
  isCableSource,
}: {
  selected: Device;
  simulator: Simulator;
  scenarioDomain: string;
  onApply: () => void;
  onDhcp: () => void | Promise<void>;
  onServerServices: (deviceId: string, action: ServerServiceAction) => void;
  onQuickCommand: (command: string) => Promise<void>;
  onAddInterface: () => void;
  onStartCable: () => void;
  onDelete: () => void;
  isCableSource: boolean;
}) {
  const primary = selected.interfaces[0] || { ip: "", mask: "" };
  const primaryInterfaceName = selected.interfaces[0]?.name || "g0/0";
  const isEndpoint = selected.type === "pc" || selected.type === "server";
  const [servicesTab, setServicesTab] = useState<ServerServicesTab>("dhcp");
  const showPrefix = ["config", "interface", "dhcp", "acl", "routing", "class-map", "policy-map"].includes(selected.cli.mode) ? "do " : "";
  const quickActions = isEndpoint
    ? [
        { label: "ipconfig", command: "ipconfig" },
        ...(selected.gateway ? [{ label: "Ping Gateway", command: `ping ${selected.gateway}` }] : []),
        ...(scenarioDomain ? [{ label: "nslookup", command: `nslookup ${scenarioDomain}` }, { label: "curl", command: `curl ${scenarioDomain}` }] : []),
        { label: "Renew DHCP", command: "ipconfig /renew" },
        { label: "Help", command: "help" },
      ]
    : [
        { label: "Interfaces", command: `${showPrefix}show ip interface brief` },
        { label: "Port Config", command: `${showPrefix}show running-config interface ${primaryInterfaceName}` },
        { label: "Descriptions", command: `${showPrefix}show interfaces description` },
        { label: "Routes", command: `${showPrefix}show ip route` },
        { label: "Running Config", command: `${showPrefix}show running-config` },
        { label: "Help", command: "help" },
      ];
  return (
    <div className="inspector">
      <div className="chips">
        <span>{selected.type}</span>
        <span>{deviceStatus(selected)}</span>
        {isCableSource && <span>cable start</span>}
      </div>
      <pre className="prebox">{selectedInterfacesText(selected)}</pre>
      <h3>Topology</h3>
      <div className="topology-actions">
        <button type="button" onClick={onStartCable}>{isCableSource ? "Pick Target Device" : "Start Cable"}</button>
        <button type="button" onClick={onAddInterface}>Add Interface</button>
        <button type="button" className="danger-button" onClick={onDelete}>Delete Device</button>
      </div>
      <h3>Quick Actions</h3>
      <div className="quick-actions">
        {quickActions.map((action) => (
          <button type="button" key={`${action.label}-${action.command}`} onClick={() => { void onQuickCommand(action.command); }}>
            {action.label}
          </button>
        ))}
      </div>
      {isEndpoint ? (
        <>
          <div className="form-grid">
            <label>IP<input id="edit-ip" defaultValue={primary.ip || ""} /></label>
            <label>Mask<input id="edit-mask" defaultValue={primary.mask || ""} /></label>
            <label>Gateway<input id="edit-gateway" defaultValue={selected.gateway || ""} /></label>
            <label>DNS<input id="edit-dns" defaultValue={selected.dns || ""} /></label>
          </div>
          <div className="button-row">
            <button type="button" onClick={onApply}>Apply Fields</button>
            <button type="button" onClick={onDhcp}>Request DHCP</button>
          </div>
          {selected.type === "server" && (
            <ServerServicesPanel
              server={selected}
              activeTab={servicesTab}
              onTab={setServicesTab}
              onAction={(action) => onServerServices(selected.id, action)}
            />
          )}
        </>
      ) : (
        <p className="small-text">Configure routers and switches through the CLI. Use show commands here to inspect the resulting state.</p>
      )}
      <h3>Details</h3>
      <dl className="details">
        <dt>Gateway</dt><dd>{selected.gateway || "--"}</dd>
        <dt>DNS</dt><dd>{selected.dns || "--"}</dd>
        <dt>Services</dt><dd>{Object.entries(selected.services).filter(([, value]) => value).map(([key]) => key).join(", ") || "--"}</dd>
        <dt>ACLs</dt><dd>{Object.keys(selected.acls).join(", ") || "--"}</dd>
        <dt>NAT</dt><dd>{selected.nat.overloadRules.length ? `${selected.nat.overloadRules.length} overload rule(s)` : "--"}</dd>
      </dl>
      {(selected.type === "router" || selected.type === "cloud") && (
        <>
          <h3>Routes</h3>
          <pre className="prebox">{simulator.routeTableText(selected)}</pre>
        </>
      )}
      {selected.nat.translations.length > 0 && (
        <>
          <h3>NAT Translations</h3>
          <pre className="prebox">{selected.nat.translations.map((entry) => `${entry.protocol} ${entry.insideLocal} -> ${entry.insideGlobal}:${entry.patPort} -> ${entry.outsideGlobal}`).join("\n")}</pre>
        </>
      )}
      {selected.interfaces.map((iface) => (
        <div key={iface.name} className="small-text">{formatInterface(iface)}{iface.natRole ? `, nat ${iface.natRole}` : ""}{iface.aclIn ? `, ACL in ${iface.aclIn}` : ""}{iface.aclOut ? `, ACL out ${iface.aclOut}` : ""}</div>
      ))}
      {getInterface(selected, "g0/0")?.helperAddress && <p className="small-text">Helper: {getInterface(selected, "g0/0")?.helperAddress}</p>}
    </div>
  );
}

function ServerServicesPanel({
  server,
  activeTab,
  onTab,
  onAction,
}: {
  server: Device;
  activeTab: ServerServicesTab;
  onTab: (tab: ServerServicesTab) => void;
  onAction: (action: ServerServiceAction) => void;
}) {
  const firstPool = server.dhcpPools[0] || { name: "SERVER_POOL", network: "", mask: "255.255.255.0", defaultRouter: server.gateway || "", dnsServer: server.interfaces[0]?.ip || server.dns || "", start: "", end: "", excludedRanges: [] };
  const recordEntries = Object.entries(server.dnsRecords).sort(([left], [right]) => left.localeCompare(right));
  const mailboxEntries = Object.entries(server.mailboxes).sort(([left], [right]) => left.localeCompare(right));

  function serviceToggle(service: ServerServiceName, label: string) {
    return (
      <label className="service-toggle">
        <input
          type="checkbox"
          checked={server.services[service]}
          onChange={(event) => onAction({ type: "toggle", service, enabled: event.currentTarget.checked })}
        />
        {label}
      </label>
    );
  }

  function submitDhcp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onAction({
      type: "dhcp-save",
      pool: {
        name: String(form.get("pool") || "SERVER_POOL"),
        network: String(form.get("network") || ""),
        mask: String(form.get("mask") || ""),
        defaultRouter: String(form.get("gateway") || ""),
        dnsServer: String(form.get("dns") || ""),
        start: String(form.get("start") || ""),
        end: String(form.get("end") || ""),
        excludedRanges: [],
      },
    });
  }

  function submitDns(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onAction({ type: "dns-save", name: String(form.get("name") || ""), ip: String(form.get("ip") || "") });
    event.currentTarget.reset();
  }

  function submitWww(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onAction({ type: "www-save", content: String(form.get("content") || "") });
  }

  function submitMailbox(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onAction({ type: "mail-user-save", user: String(form.get("user") || "") });
    event.currentTarget.reset();
  }

  return (
    <section className="server-services" aria-label="Server Services">
      <div className="services-header">
        <h3>Services</h3>
        <span>{server.interfaces[0]?.ip || "no server IP"}</span>
      </div>
      <div className="service-switches" aria-label="Service toggles">
        {serviceToggle("dhcp", "DHCP")}
        {serviceToggle("dns", "DNS")}
        {serviceToggle("http", "WWW")}
        {serviceToggle("mail", "MAIL")}
      </div>
      <div className="service-tabs" role="tablist" aria-label="Server service tabs">
        {(["dhcp", "dns", "www", "mail"] as ServerServicesTab[]).map((tab) => (
          <button type="button" role="tab" aria-selected={activeTab === tab} className={activeTab === tab ? "active" : ""} key={tab} onClick={() => onTab(tab)}>
            {tab.toUpperCase()}
          </button>
        ))}
      </div>
      {activeTab === "dhcp" && (
        <div className="service-pane">
          <form className="service-form" onSubmit={submitDhcp}>
            <label>Pool<input name="pool" defaultValue={firstPool.name} /></label>
            <label>Network<input name="network" defaultValue={firstPool.network} placeholder="192.168.20.0" /></label>
            <label>Mask<input name="mask" defaultValue={firstPool.mask} placeholder="255.255.255.0" /></label>
            <label>Gateway<input name="gateway" defaultValue={firstPool.defaultRouter} placeholder="192.168.20.1" /></label>
            <label>DNS<input name="dns" defaultValue={firstPool.dnsServer} placeholder={server.interfaces[0]?.ip || "8.8.8.8"} /></label>
            <label>Start IP<input name="start" defaultValue={firstPool.start || ""} placeholder="optional" /></label>
            <label>End IP<input name="end" defaultValue={firstPool.end || ""} placeholder="optional" /></label>
            <button type="submit" className="btn-accent">Save DHCP</button>
          </form>
          <div className="service-list">
            {server.dhcpPools.length ? server.dhcpPools.map((pool) => (
              <div className="service-row" key={pool.name}>
                <span>{pool.name}: {pool.network} / {pool.mask}, GW {pool.defaultRouter}, DNS {pool.dnsServer}</span>
                <button type="button" onClick={() => onAction({ type: "dhcp-delete", name: pool.name })}>Delete</button>
              </div>
            )) : <p className="small-text">No DHCP pools configured.</p>}
          </div>
        </div>
      )}
      {activeTab === "dns" && (
        <div className="service-pane">
          <form className="service-form compact" onSubmit={submitDns}>
            <label>Domain<input name="name" placeholder="lab.local" /></label>
            <label>Address<input name="ip" placeholder={server.interfaces[0]?.ip || "10.10.10.10"} /></label>
            <button type="submit" className="btn-accent">Add DNS</button>
          </form>
          <div className="service-list">
            {recordEntries.length ? recordEntries.map(([name, ip]) => (
              <div className="service-row" key={name}>
                <span>{name} {"->"} {ip}</span>
                <button type="button" onClick={() => onAction({ type: "dns-delete", name })}>Delete</button>
              </div>
            )) : <p className="small-text">No DNS records configured.</p>}
          </div>
        </div>
      )}
      {activeTab === "www" && (
        <div className="service-pane">
          <form className="service-form single" onSubmit={submitWww}>
            <label>HTTP Response<textarea name="content" key={server.httpContent} defaultValue={server.httpContent} rows={5} /></label>
            <button type="submit" className="btn-accent">Save WWW</button>
          </form>
          <pre className="service-preview">HTTP/1.1 200 OK{"\n"}Server: {server.name}{"\n\n"}{server.httpContent}</pre>
        </div>
      )}
      {activeTab === "mail" && (
        <div className="service-pane">
          <form className="service-form compact" onSubmit={submitMailbox}>
            <label>Mailbox<input name="user" placeholder="admin" /></label>
            <button type="submit" className="btn-accent">Add Mailbox</button>
          </form>
          <div className="service-list">
            {mailboxEntries.length ? mailboxEntries.map(([user, messages]) => (
              <div className="service-row" key={user}>
                <span>{user}: {messages.length} message(s)</span>
                <button type="button" onClick={() => onAction({ type: "mail-clear", user })}>Clear</button>
              </div>
            )) : <p className="small-text">No mailboxes configured.</p>}
          </div>
        </div>
      )}
    </section>
  );
}
