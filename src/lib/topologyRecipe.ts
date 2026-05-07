import type { Device, LabState, Link, NetworkInterface, StaticRoute } from "../types";
import { intToIp, ipInSubnet, ipToInt, isValidIp, maskToPrefix, networkAddress, normalizeMask, prefixToMask } from "./ip";
import { createDefaultCliState } from "./simulator";

export interface RecipeOptions {
  routerCount: number;
  innerPattern: string;
  innerMask: string;
  outerPattern: string;
  outerMask: string;
  staticRoutes: boolean;
  autoNoShutdown: boolean;
}

export interface RecipeLinkPlan {
  label: string;
  leftRouter: string;
  rightRouter: string;
  leftIp: string;
  rightIp: string;
  mask: string;
  network: string;
}

export interface RecipeLanPlan {
  label: string;
  router: string;
  gatewayIp: string;
  pcIp: string;
  mask: string;
  network: string;
}

export interface RecipeConfigPreview {
  deviceId: string;
  title: string;
  commands: string[];
}

export interface RecipePreview {
  routerNames: string[];
  innerLinks: RecipeLinkPlan[];
  lans: RecipeLanPlan[];
  configs: RecipeConfigPreview[];
  warnings: string[];
  errors: string[];
}

const RECIPE_SCENARIO_ID = "recipe";
const RECIPE_LEFT_X = 55;
const RECIPE_DEFAULT_SPAN_X = 480;
const RECIPE_WIDE_SPAN_X = 600;
const RECIPE_MAX_DEVICE_X = 820;

function splitPatternAndMask(pattern: string, fallbackMask: string): { pattern: string; mask: string } {
  const trimmed = pattern.trim();
  if (trimmed.includes("/")) {
    const [address, prefix] = trimmed.split("/");
    const mask = prefixToMask(Number(prefix));
    return { pattern: address.trim(), mask: mask || normalizeMask(fallbackMask) };
  }
  const parts = trimmed.split(/\s+/);
  if (parts.length > 1) return { pattern: parts[0], mask: normalizeMask(parts[1]) };
  return { pattern: trimmed, mask: normalizeMask(fallbackMask) };
}

function expandAddressPattern(rawPattern: string, index: number): { ip: string; errors: string[] } {
  const errors: string[] = [];
  const octets = rawPattern.trim().split(".");
  if (octets.length !== 4) return { ip: "", errors: [`Address pattern '${rawPattern}' must have four octets.`] };

  const values = octets.map((octet) => {
    const match = octet.match(/^(\d+)(?:\+(\d+))?$/);
    if (!match) {
      errors.push(`Octet '${octet}' is not valid. Use a number or <start>+<step>.`);
      return 0;
    }
    const value = Number(match[1]) + Number(match[2] || 0) * index;
    if (value > 255) errors.push(`Octet '${octet}' expands to ${value}, which is above 255.`);
    return value;
  });

  const ip = values.join(".");
  if (!isValidIp(ip)) errors.push(`Generated IP '${ip}' is invalid.`);
  return { ip, errors };
}

function normalizeOptions(options: RecipeOptions): RecipeOptions {
  return {
    routerCount: Math.max(2, Math.min(6, Math.floor(Number(options.routerCount) || 4))),
    innerPattern: options.innerPattern || "15+1.38.47.1",
    innerMask: options.innerMask || "255.255.255.252",
    outerPattern: options.outerPattern || "15+10.1.1.1",
    outerMask: options.outerMask || "255.255.255.0",
    staticRoutes: Boolean(options.staticRoutes),
    autoNoShutdown: options.autoNoShutdown !== false,
  };
}

function peerAddress(ip: string): string {
  return intToIp(ipToInt(ip) + 1);
}

function pcAddress(gatewayIp: string): string {
  return intToIp(ipToInt(gatewayIp) + 9);
}

function routeForLan(lan: RecipeLanPlan): StaticRoute {
  return { network: lan.network, mask: lan.mask, nextHop: "", metric: 1 };
}

function buildStaticRoutes(routerIndex: number, innerLinks: RecipeLinkPlan[], lans: RecipeLanPlan[]): StaticRoute[] {
  return lans.flatMap((lan, lanIndex) => {
    if (lanIndex === routerIndex) return [];
    const route = routeForLan(lan);
    if (lanIndex > routerIndex) route.nextHop = innerLinks[routerIndex]?.rightIp || "";
    else route.nextHop = innerLinks[routerIndex - 1]?.leftIp || "";
    return route.nextHop ? [route] : [];
  });
}

function nextInterfaceName(counters: number[], routerIndex: number, preference: "fa" | "g" = "fa"): string {
  const value = counters[routerIndex];
  counters[routerIndex] += 1;
  return `${preference}0/${value}`;
}

export function previewRecipe(rawOptions: RecipeOptions): RecipePreview {
  const options = normalizeOptions(rawOptions);
  const routerNames = Array.from({ length: options.routerCount }, (_, index) => `R${index + 1}`);
  const warnings: string[] = [];
  const errors: string[] = [];
  const innerParts = splitPatternAndMask(options.innerPattern, options.innerMask);
  const outerParts = splitPatternAndMask(options.outerPattern, options.outerMask);
  const innerMask = innerParts.mask;
  const outerMask = outerParts.mask;

  if (!innerMask) errors.push("Inner link mask is invalid.");
  if (!outerMask) errors.push("Outer LAN mask is invalid.");

  const innerLinks: RecipeLinkPlan[] = [];
  for (let index = 0; index < options.routerCount - 1; index += 1) {
    const expanded = expandAddressPattern(innerParts.pattern, index);
    errors.push(...expanded.errors);
    const rightIp = expanded.ip ? peerAddress(expanded.ip) : "";
    if (expanded.ip && innerMask && !ipInSubnet(rightIp, expanded.ip, innerMask)) warnings.push(`${expanded.ip} and ${rightIp} are not in the same ${innerMask} subnet.`);
    innerLinks.push({
      label: `${routerNames[index]}-${routerNames[index + 1]}`,
      leftRouter: routerNames[index],
      rightRouter: routerNames[index + 1],
      leftIp: expanded.ip,
      rightIp,
      mask: innerMask,
      network: expanded.ip && innerMask ? networkAddress(expanded.ip, innerMask) : "",
    });
  }

  const lans: RecipeLanPlan[] = [];
  for (let index = 0; index < options.routerCount; index += 1) {
    const expanded = expandAddressPattern(outerParts.pattern, index);
    errors.push(...expanded.errors);
    const pcIp = expanded.ip ? pcAddress(expanded.ip) : "";
    if (expanded.ip && outerMask && !ipInSubnet(pcIp, expanded.ip, outerMask)) warnings.push(`${expanded.ip} and generated PC ${pcIp} are not in the same ${outerMask} subnet.`);
    lans.push({
      label: `${routerNames[index]} LAN`,
      router: routerNames[index],
      gatewayIp: expanded.ip,
      pcIp,
      mask: outerMask,
      network: expanded.ip && outerMask ? networkAddress(expanded.ip, outerMask) : "",
    });
  }

  const networks = new Set<string>();
  [...innerLinks.map((link) => `${link.network}/${link.mask}`), ...lans.map((lan) => `${lan.network}/${lan.mask}`)].forEach((network) => {
    if (network.startsWith("/")) return;
    if (networks.has(network)) warnings.push(`Generated network ${network} appears more than once.`);
    networks.add(network);
  });

  const configs = buildConfigPreview(options, routerNames, innerLinks, lans);
  return { routerNames, innerLinks, lans, configs, warnings, errors };
}

function buildConfigPreview(options: RecipeOptions, routerNames: string[], innerLinks: RecipeLinkPlan[], lans: RecipeLanPlan[]): RecipeConfigPreview[] {
  const interfaceCounters = Array.from({ length: routerNames.length }, () => 0);
  const routePlans = options.staticRoutes ? routerNames.map((_, index) => buildStaticRoutes(index, innerLinks, lans)) : routerNames.map(() => []);

  return routerNames.map((routerName, routerIndex) => {
    const commands = ["enable", "configure terminal"];
    innerLinks.forEach((link) => {
      if (link.leftRouter !== routerName && link.rightRouter !== routerName) return;
      const peer = link.leftRouter === routerName ? link.rightRouter : link.leftRouter;
      const ip = link.leftRouter === routerName ? link.leftIp : link.rightIp;
      const iface = nextInterfaceName(interfaceCounters, routerIndex);
      commands.push(`interface ${iface}`, `description to ${peer}`, `ip address ${ip} ${link.mask}`);
      commands.push(options.autoNoShutdown ? "no shutdown" : "shutdown", "exit");
    });
    const lan = lans[routerIndex];
    const lanIface = nextInterfaceName(interfaceCounters, routerIndex);
    commands.push(`interface ${lanIface}`, `description ${lan.label} ${lan.network}/${maskToPrefix(lan.mask)}`, `ip address ${lan.gatewayIp} ${lan.mask}`);
    commands.push(options.autoNoShutdown ? "no shutdown" : "shutdown", "exit");
    routePlans[routerIndex].forEach((route) => commands.push(`ip route ${route.network} ${route.mask} ${route.nextHop}`));
    commands.push("end");
    return { deviceId: routerName.toLowerCase(), title: `${routerName} baseline`, commands };
  });
}

export function buildRecipeLab(rawOptions: RecipeOptions, prior?: Partial<LabState>): { lab: LabState; preview: RecipePreview } | { error: string; preview: RecipePreview } {
  const options = normalizeOptions(rawOptions);
  const preview = previewRecipe(options);
  if (preview.errors.length) return { error: preview.errors.join(" "), preview };

  const devices: Record<string, Device> = {};
  const links: Link[] = [];
  const interfaceCounters = Array.from({ length: options.routerCount }, () => 0);
  const spanX = options.routerCount <= 4 ? RECIPE_DEFAULT_SPAN_X : RECIPE_WIDE_SPAN_X;
  const routerCoords = Array.from({ length: options.routerCount }, (_, index) => ({
    x: Math.round(RECIPE_LEFT_X + (options.routerCount === 1 ? 0 : (spanX / (options.routerCount - 1)) * index)),
    y: 160,
  }));

  preview.routerNames.forEach((routerName, index) => {
    devices[routerName.toLowerCase()] = {
      id: routerName.toLowerCase(),
      name: routerName,
      type: "router",
      x: routerCoords[index].x,
      y: routerCoords[index].y,
      interfaces: [],
      gateway: "",
      dns: "",
      services: { dhcp: false, dns: false, http: false, mail: false },
      dnsRecords: {},
      httpContent: `Welcome to ${routerName} (simulated response).`,
      mailboxes: {},
      dhcpExcluded: [],
      dhcpPools: [],
      dhcpBindings: [],
      staticRoutes: options.staticRoutes ? buildStaticRoutes(index, preview.innerLinks, preview.lans) : [],
      dynamicRouting: [],
      acls: {},
      nat: { overloadRules: [], translations: [], nextPort: 10000 },
      qos: { enabled: false, trust: "", classMaps: {}, policyMaps: {} },
      cli: createDefaultCliState(),
    };
  });

  preview.innerLinks.forEach((link, index) => {
    const leftIndex = Number(link.leftRouter.slice(1)) - 1;
    const rightIndex = Number(link.rightRouter.slice(1)) - 1;
    const left = devices[link.leftRouter.toLowerCase()];
    const right = devices[link.rightRouter.toLowerCase()];
    const leftIf = nextInterfaceName(interfaceCounters, leftIndex);
    const rightIf = nextInterfaceName(interfaceCounters, rightIndex);
    left.interfaces.push(interfaceSeed(leftIf, link.leftIp, link.mask, options.autoNoShutdown, `to ${link.rightRouter}`));
    right.interfaces.push(interfaceSeed(rightIf, link.rightIp, link.mask, options.autoNoShutdown, `to ${link.leftRouter}`));
    links.push({ id: `inner-${index + 1}`, from: left.id, to: right.id, fromIf: leftIf, toIf: rightIf });
  });

  preview.lans.forEach((lan, index) => {
    const router = devices[lan.router.toLowerCase()];
    const routerIf = nextInterfaceName(interfaceCounters, index);
    router.interfaces.push(interfaceSeed(routerIf, lan.gatewayIp, lan.mask, options.autoNoShutdown, `${lan.label} ${lan.network}/${maskToPrefix(lan.mask)}`));

    const switchId = `sw${index + 1}`;
    const pcId = `pc${index + 1}`;
    const lanAbove = index % 2 === 0;
    devices[switchId] = {
      id: switchId,
      name: `SW${index + 1}`,
      type: "switch",
      x: routerCoords[index].x,
      y: lanAbove ? 45 : 285,
      interfaces: [interfaceSeed("fa0/1", "", "", true, `to ${lan.router}`), interfaceSeed("fa0/2", "", "", true, `to PC${index + 1}`)],
      gateway: "",
      dns: "",
      services: { dhcp: false, dns: false, http: false, mail: false },
      dnsRecords: {},
      httpContent: `Welcome to SW${index + 1} (simulated response).`,
      mailboxes: {},
      dhcpExcluded: [],
      dhcpPools: [],
      dhcpBindings: [],
      staticRoutes: [],
      dynamicRouting: [],
      acls: {},
      nat: { overloadRules: [], translations: [], nextPort: 10000 },
      qos: { enabled: false, trust: "", classMaps: {}, policyMaps: {} },
      cli: createDefaultCliState(),
    };
    devices[pcId] = {
      id: pcId,
      name: `PC${index + 1}`,
      type: "pc",
      x: Math.max(10, Math.min(RECIPE_MAX_DEVICE_X, routerCoords[index].x + (lanAbove ? -45 : 45))),
      y: lanAbove ? 15 : 330,
      interfaces: [interfaceSeed("eth0", lan.pcIp, lan.mask, true, `${lan.label} host`)],
      gateway: lan.gatewayIp,
      dns: "",
      services: { dhcp: false, dns: false, http: false, mail: false },
      dnsRecords: {},
      httpContent: `Welcome to PC${index + 1} (simulated response).`,
      mailboxes: {},
      dhcpExcluded: [],
      dhcpPools: [],
      dhcpBindings: [],
      staticRoutes: [],
      dynamicRouting: [],
      acls: {},
      nat: { overloadRules: [], translations: [], nextPort: 10000 },
      qos: { enabled: false, trust: "", classMaps: {}, policyMaps: {} },
      cli: createDefaultCliState(),
    };
    links.push({ id: `lan-router-${index + 1}`, from: router.id, to: switchId, fromIf: routerIf, toIf: "fa0/1" });
    links.push({ id: `lan-pc-${index + 1}`, from: switchId, to: pcId, fromIf: "fa0/2", toIf: "eth0" });
  });

  const lab: LabState = {
    currentScenarioId: RECIPE_SCENARIO_ID,
    selectedDeviceId: "r1",
    mode: prior?.mode || "Build",
    theme: prior?.theme || "light",
    devices,
    links,
    events: prior?.events || [],
    progress: prior?.progress || {},
    score: prior?.score || 0,
    terminalLines: [
      `Netpket generated ${options.routerCount} routers, ${options.routerCount} LANs, and ${links.length} links from recipe.`,
      `Inner pattern: ${options.innerPattern} ${options.innerMask}`,
      `Outer pattern: ${options.outerPattern} ${options.outerMask}`,
    ],
    lastFlow: null,
  };
  lab.events.push({ time: new Date().toLocaleTimeString(), level: "success", message: `Generated recipe lab with ${options.routerCount} routers.` });
  return { lab, preview };
}

function interfaceSeed(name: string, ip: string, mask: string, up: boolean, description: string): NetworkInterface {
  return { name, ip, mask, up, description, natRole: null, aclIn: null, aclOut: null, helperAddress: "", servicePolicyIn: "", servicePolicyOut: "" };
}
