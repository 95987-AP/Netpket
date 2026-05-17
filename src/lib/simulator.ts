import type {
  AclEntry,
  AclList,
  ConnectivityResult,
  Device,
  DhcpPool,
  DynamicNetwork,
  DynamicRoutingProcess,
  FlowState,
  FlowStep,
  LabState,
  Link,
  NatTranslation,
  NetworkInterface,
  Protocol,
  QosClassMap,
  QosPolicyMap,
  RoutingProtocol,
  Scenario,
  StaticRoute,
} from "../types";
import {
  deepClone,
  firstUsableIp,
  formatInterface,
  getInterface,
  intToIp,
  ipInSubnet,
  ipToInt,
  isPrivateIp,
  isValidIp,
  isValidMask,
  lastUsableIp,
  maskToPrefix,
  networkAddress,
  normalizeInterfaceName,
  normalizeMask,
  normalizeRange,
} from "./ip";

export const STORAGE_KEY = "networklab-trainer-v2";
export const MODES = ["Learn", "Build", "Scenario", "Simulation", "Review"];

export function createDefaultCliState() {
  return {
    mode: "user" as const,
    currentInterface: null,
    currentDhcpPool: null,
    currentAcl: null,
    currentRouting: null,
    currentClassMap: null,
    currentPolicyMap: null,
    currentPolicyClass: null,
    history: [],
    historyCursor: null,
    historyDraft: "",
    terminalLines: [],
    commandDraft: "",
  };
}

export function normalizeDevice(raw: Scenario["devices"][number]): Device {
  return {
    id: raw.id,
    name: raw.name,
    type: raw.type,
    x: raw.x,
    y: raw.y,
    interfaces: (raw.interfaces || []).map((iface) => ({
      name: iface.name || "eth0",
      ip: iface.ip || "",
      mask: iface.mask || "",
      up: Boolean(iface.up),
      natRole: iface.natRole || null,
      aclIn: iface.aclIn || null,
      aclOut: iface.aclOut || null,
      description: iface.description || "",
      helperAddress: iface.helperAddress || "",
      servicePolicyIn: iface.servicePolicyIn || "",
      servicePolicyOut: iface.servicePolicyOut || "",
    })),
    gateway: raw.gateway || "",
    dns: raw.dns || "",
    services: {
      dhcp: Boolean(raw.services?.dhcp),
      dns: Boolean(raw.services?.dns),
      http: Boolean(raw.services?.http),
      mail: Boolean(raw.services?.mail),
    },
    dnsRecords: raw.dnsRecords ? { ...raw.dnsRecords } : {},
    httpContent: raw.httpContent || `Welcome to ${raw.name} (simulated response).`,
    mailboxes: raw.mailboxes ? deepClone(raw.mailboxes) : {},
    dhcpExcluded: (raw.dhcpExcluded || []).map(normalizeRange).filter(Boolean) as Device["dhcpExcluded"],
    dhcpPools: (raw.dhcpPools || []).map(normalizeDhcpPool).filter(Boolean) as DhcpPool[],
    dhcpBindings: raw.dhcpBindings ? deepClone(raw.dhcpBindings) : [],
    staticRoutes: (raw.staticRoutes || []).map(normalizeStaticRoute).filter(Boolean) as StaticRoute[],
    dynamicRouting: (raw.dynamicRouting || []).map(normalizeDynamicRouting).filter(Boolean) as DynamicRoutingProcess[],
    acls: normalizeAcls(raw.acls || {}),
    nat: {
      overloadRules: raw.nat?.overloadRules ? deepClone(raw.nat.overloadRules) : [],
      translations: raw.nat?.translations ? deepClone(raw.nat.translations) : [],
      nextPort: raw.nat?.nextPort || 10000,
    },
    qos: {
      enabled: Boolean(raw.qos?.enabled),
      trust: raw.qos?.trust || "",
      classMaps: raw.qos?.classMaps ? normalizeQosClassMaps(raw.qos.classMaps) : {},
      policyMaps: raw.qos?.policyMaps ? normalizeQosPolicyMaps(raw.qos.policyMaps) : {},
    },
    cli: raw.cli ? { ...createDefaultCliState(), ...raw.cli } : createDefaultCliState(),
  };
}

export function createLabState(scenario: Scenario, prior?: Partial<LabState>): LabState {
  const devices: Record<string, Device> = {};
  scenario.devices.forEach((raw) => {
    const device = normalizeDevice(raw);
    devices[device.id] = device;
  });
  const selectedDeviceId = scenario.devices[0]?.id || null;
  if (selectedDeviceId && devices[selectedDeviceId] && !devices[selectedDeviceId].cli.terminalLines.length) {
    devices[selectedDeviceId].cli.terminalLines = ["Netpket ready. Select a device and type help."];
  }

  return {
    currentScenarioId: scenario.id,
    selectedDeviceId,
    mode: prior?.mode && MODES.includes(prior.mode) ? prior.mode : "Learn",
    theme: prior?.theme || "dark",
    devices,
    links: deepClone(scenario.links),
    events: prior?.events || [],
    progress: prior?.progress || {},
    score: prior?.score || 0,
    terminalLines: ["Netpket ready. Select a device and type help."],
    lastFlow: null,
  };
}

export function nowTime(): string {
  return new Date().toLocaleTimeString();
}

export function addEvent(lab: LabState, message: string, level: "info" | "success" | "warn" | "error" = "info") {
  lab.events.push({ time: nowTime(), message, level });
  if (lab.events.length > 300) lab.events.shift();
}

export function addTerminalLine(lab: LabState, line: string) {
  const device = selectedDevice(lab);
  const lines = device ? device.cli.terminalLines : lab.terminalLines;
  lines.push(line);
  if (lines.length > 300) lines.shift();
}

export function addTerminalOutput(lab: LabState, output: string) {
  if (!output) return;
  output.split("\n").forEach((line) => addTerminalLine(lab, line));
}

export function addTerminalLineForDevice(lab: LabState, deviceId: string | null | undefined, line: string) {
  const device = deviceId ? lab.devices[deviceId] : null;
  const lines = device ? device.cli.terminalLines : lab.terminalLines;
  lines.push(line);
  if (lines.length > 300) lines.shift();
}

export function addTerminalOutputForDevice(lab: LabState, deviceId: string | null | undefined, output: string) {
  if (!output) return;
  output.split("\n").forEach((line) => addTerminalLineForDevice(lab, deviceId, line));
}

export function clearTerminalForDevice(lab: LabState, deviceId: string | null | undefined) {
  const device = deviceId ? lab.devices[deviceId] : null;
  if (device) device.cli.terminalLines = [];
  else lab.terminalLines = [];
}

export function terminalLinesForDevice(lab: LabState, device: Device | null): string[] {
  if (device) return device.cli.terminalLines;
  return lab.terminalLines;
}

export function deviceStatus(device: Device): "green" | "yellow" | "red" {
  if (!device.interfaces.length) return "yellow";
  if (device.type === "switch") return device.interfaces.every((iface) => iface.up) ? "green" : "red";
  const configured = device.interfaces.filter((iface) => iface.up && iface.ip);
  if (configured.length === device.interfaces.length) return "green";
  if (configured.length > 0) return "yellow";
  return "red";
}

export function selectedDevice(lab: LabState): Device | null {
  return lab.selectedDeviceId ? lab.devices[lab.selectedDeviceId] || null : null;
}

function normalizeDhcpPool(pool: DhcpPool): DhcpPool | null {
  const mask = normalizeMask(pool.mask);
  if (!isValidIp(pool.network) || !mask) return null;
  return {
    name: pool.name || "POOL",
    network: networkAddress(pool.network, mask),
    mask,
    start: isValidIp(pool.start || "") ? pool.start : firstUsableIp(pool.network, mask),
    end: isValidIp(pool.end || "") ? pool.end : lastUsableIp(pool.network, mask),
    defaultRouter: isValidIp(pool.defaultRouter || "") ? pool.defaultRouter : "",
    dnsServer: isValidIp(pool.dnsServer || "") ? pool.dnsServer : "",
    excludedRanges: (pool.excludedRanges || []).map(normalizeRange).filter(Boolean) as DhcpPool["excludedRanges"],
  };
}

function normalizeStaticRoute(route: StaticRoute): StaticRoute | null {
  const mask = normalizeMask(route.mask);
  if (!isValidIp(route.network) || !mask) return null;
  return {
    network: networkAddress(route.network, mask),
    mask,
    nextHop: isValidIp(route.nextHop || "") ? route.nextHop : "",
    interface: route.interface || "",
    metric: route.metric || 1,
  };
}

function normalizeDynamicNetwork(item: Partial<DynamicNetwork>): DynamicNetwork | null {
  if (!isValidIp(item.network || "")) return null;
  return { network: item.network || "", wildcard: isValidIp(item.wildcard || "") ? item.wildcard || "" : "" };
}

function normalizeDynamicRouting(process: Partial<DynamicRoutingProcess>): DynamicRoutingProcess | null {
  if (process.protocol !== "rip" && process.protocol !== "eigrp") return null;
  return {
    protocol: process.protocol,
    processId: process.processId || (process.protocol === "rip" ? "rip" : "1"),
    networks: (process.networks || []).map(normalizeDynamicNetwork).filter(Boolean) as DynamicNetwork[],
    version: process.version || (process.protocol === "rip" ? 2 : undefined),
    noAutoSummary: Boolean(process.noAutoSummary),
    passiveInterfaces: process.passiveInterfaces || [],
  };
}

function normalizeQosClassMaps(classMaps: Record<string, QosClassMap>): Record<string, QosClassMap> {
  const result: Record<string, QosClassMap> = {};
  Object.entries(classMaps || {}).forEach(([name, classMap]) => {
    result[name] = { name: classMap.name || name, matchType: classMap.matchType === "all" ? "all" : "any", matches: classMap.matches || [] };
  });
  return result;
}

function normalizeQosPolicyMaps(policyMaps: Record<string, QosPolicyMap>): Record<string, QosPolicyMap> {
  const result: Record<string, QosPolicyMap> = {};
  Object.entries(policyMaps || {}).forEach(([name, policyMap]) => {
    result[name] = { name: policyMap.name || name, classes: policyMap.classes || [] };
  });
  return result;
}

function normalizeAcls(acls: unknown): Record<string, AclList> {
  if (!acls || typeof acls !== "object") return {};
  const result: Record<string, AclList> = {};
  Object.entries(acls as Record<string, AclList | AclEntry[]>).forEach(([name, value]) => {
    const entries = Array.isArray(value) ? value : value.entries || [];
    result[name] = {
      name,
      type: "extended",
      entries: entries.map(normalizeAclEntry).filter(Boolean) as AclEntry[],
    };
  });
  return result;
}

export function normalizeAclEntry(entry: Partial<AclEntry>): AclEntry | null {
  const action = entry.action === "permit" ? "permit" : "deny";
  const protocol = ["ip", "icmp", "tcp", "udp"].includes(String(entry.protocol)) ? entry.protocol as Protocol : "ip";
  const source = entry.source || { value: "any", wildcard: "255.255.255.255" };
  const destination = entry.destination || { value: "any", wildcard: "255.255.255.255" };
  return {
    action,
    protocol,
    source: {
      value: source.value || "any",
      wildcard: source.value === "any" ? "255.255.255.255" : source.wildcard || "0.0.0.0",
    },
    destination: {
      value: destination.value || "any",
      wildcard: destination.value === "any" ? "255.255.255.255" : destination.wildcard || "0.0.0.0",
    },
    port: entry.port || null,
  };
}

function isRoutingDevice(device: Device): boolean {
  return device.type === "router" || device.type === "cloud";
}

function configuredUpInterfaces(device: Device): NetworkInterface[] {
  return device.interfaces.filter((iface) => iface.up && isValidIp(iface.ip) && normalizeMask(iface.mask));
}

function wildcardToMask(wildcard: string): string {
  if (!isValidIp(wildcard)) return "";
  return intToIp((~ipToInt(wildcard)) >>> 0);
}

function classfulMask(ip: string): string {
  const firstOctet = Number(ip.split(".")[0]);
  if (firstOctet < 128) return "255.0.0.0";
  if (firstOctet < 192) return "255.255.0.0";
  return "255.255.255.0";
}

function dynamicNetworkMatchesInterface(item: DynamicNetwork, iface: NetworkInterface): boolean {
  if (!isValidIp(iface.ip) || !normalizeMask(iface.mask) || !isValidIp(item.network)) return false;
  if (item.wildcard && isValidIp(item.wildcard)) {
    const mask = wildcardToMask(item.wildcard);
    return Boolean(mask && ipInSubnet(iface.ip, networkAddress(item.network, mask), mask));
  }
  return networkAddress(iface.ip, iface.mask) === networkAddress(item.network, iface.mask)
    || ipInSubnet(iface.ip, networkAddress(item.network, classfulMask(item.network)), classfulMask(item.network));
}

function routingProcessKey(process: DynamicRoutingProcess): string {
  return `${process.protocol}:${process.protocol === "eigrp" ? process.processId : "rip"}`;
}

function routingProcessUsesInterface(process: DynamicRoutingProcess, iface: NetworkInterface | null): boolean {
  if (!iface || !iface.up || !isValidIp(iface.ip) || !normalizeMask(iface.mask)) return false;
  if ((process.passiveInterfaces || []).some((name) => normalizeInterfaceName(name) === normalizeInterfaceName(iface.name))) return false;
  return process.networks.some((network) => dynamicNetworkMatchesInterface(network, iface));
}

export function dynamicRoutingLinkStatus(lab: LabState, link: Link): "ok" | "bad" | null {
  const from = lab.devices[link.from];
  const to = lab.devices[link.to];
  if (!from || !to || from.type !== "router" || to.type !== "router") return null;
  if (!from.dynamicRouting.length && !to.dynamicRouting.length) return null;

  const fromIface = getInterface(from, link.fromIf);
  const toIface = getInterface(to, link.toIf);
  const interfacesCanNeighbor = Boolean(
    fromIface
      && toIface
      && fromIface.up
      && toIface.up
      && isValidIp(fromIface.ip)
      && isValidIp(toIface.ip)
      && normalizeMask(fromIface.mask)
      && normalizeMask(toIface.mask)
      && ipInSubnet(toIface.ip, networkAddress(fromIface.ip, fromIface.mask), fromIface.mask)
      && ipInSubnet(fromIface.ip, networkAddress(toIface.ip, toIface.mask), toIface.mask)
  );

  const hasWorkingProcess = from.dynamicRouting.some((process) => {
    const peerProcess = to.dynamicRouting.find((candidate) => routingProcessKey(candidate) === routingProcessKey(process));
    if (!peerProcess) return false;
    return interfacesCanNeighbor
      && routingProcessUsesInterface(process, fromIface)
      && routingProcessUsesInterface(peerProcess, toIface);
  });

  return hasWorkingProcess ? "ok" : "bad";
}

export class Simulator {
  constructor(private lab: LabState) {}

  findDeviceByIp(ip: string): { device: Device; iface: NetworkInterface } | null {
    if (!isValidIp(ip)) return null;
    for (const device of Object.values(this.lab.devices)) {
      for (const iface of device.interfaces) {
        if (iface.ip === ip) return { device, iface };
      }
    }
    return null;
  }

  getAcl(device: Device | null | undefined, aclName: string | null | undefined): AclList | null {
    if (!device || !aclName) return null;
    const key = Object.keys(device.acls).find((name) => name.toLowerCase() === aclName.toLowerCase());
    return key ? device.acls[key] : null;
  }

  evaluateAcl(device: Device, aclName: string | null | undefined, packet: { protocol: Protocol; srcIp: string; dstIp: string; port?: number | null }) {
    if (!aclName) return { permitted: true, reason: "no ACL" };
    const acl = this.getAcl(device, aclName);
    if (!acl) return { permitted: false, reason: `ACL ${aclName} not found` };

    for (let index = 0; index < acl.entries.length; index += 1) {
      const entry = acl.entries[index];
      const protocolMatch = entry.protocol === "ip" || entry.protocol === packet.protocol;
      if (!protocolMatch) continue;
      if (!this.aclAddressMatches(packet.srcIp, entry.source.value, entry.source.wildcard)) continue;
      if (!this.aclAddressMatches(packet.dstIp, entry.destination.value, entry.destination.wildcard)) continue;
      if ((entry.protocol === "tcp" || entry.protocol === "udp") && entry.port && Number(entry.port) !== Number(packet.port || 0)) continue;
      return { permitted: entry.action === "permit", reason: `rule ${index + 1} ${entry.action} ${entry.protocol}` };
    }

    return { permitted: false, reason: "implicit deny" };
  }

  private aclAddressMatches(ip: string, value: string, wildcard: string): boolean {
    if (value === "any") return true;
    if (!isValidIp(ip) || !isValidIp(value) || !isValidIp(wildcard)) return false;
    const mask = (~ipToInt(wildcard)) >>> 0;
    return (ipToInt(ip) & mask) === (ipToInt(value) & mask);
  }

  private applyAcl(device: Device, iface: NetworkInterface | null, direction: "in" | "out", packet: { protocol: Protocol; srcIp: string; dstIp: string; port?: number | null }, reasons: string[], steps: FlowStep[]): boolean {
    const aclName = direction === "in" ? iface?.aclIn : iface?.aclOut;
    if (!aclName) return true;
    const verdict = this.evaluateAcl(device, aclName, packet);
    reasons.push(`ACL ${direction.toUpperCase()} ${device.name}/${iface?.name}: ${verdict.reason}`);
    steps.push({
      kind: "acl",
      label: `ACL ${direction.toUpperCase()}`,
      detail: `${device.name}/${iface?.name || "interface"} ${verdict.permitted ? "permits" : "blocks"} packet by ${verdict.reason}.`,
      status: verdict.permitted ? "ok" : "bad",
      deviceId: device.id,
    });
    return verdict.permitted;
  }

  private applyQos(device: Device, iface: NetworkInterface | null, direction: "in" | "out", packet: { protocol: Protocol; srcIp: string; dstIp: string; port?: number | null }, reasons: string[], steps: FlowStep[]) {
    const policyName = direction === "in" ? iface?.servicePolicyIn : iface?.servicePolicyOut;
    if (!policyName) return;
    const policy = device.qos.policyMaps[policyName];
    if (!policy) {
      steps.push({ kind: "qos", label: "QoS", detail: `${device.name}/${iface?.name || "interface"} references missing policy-map ${policyName}.`, status: "warn", deviceId: device.id });
      return;
    }
    const protocolLabel = packet.protocol === "tcp" && packet.port === 80 ? "http" : packet.protocol === "tcp" && packet.port === 25 ? "smtp" : packet.protocol === "udp" && packet.port === 53 ? "dns" : packet.protocol;
    const matchedClass = policy.classes.find((policyClass) => {
      const classMap = device.qos.classMaps[policyClass.className];
      return classMap?.matches.some((match) => {
        const normalized = match.toLowerCase();
        return normalized === `protocol ${protocolLabel}` || normalized === `protocol ${packet.protocol}` || normalized.includes("access-group");
      });
    }) || policy.classes[0];
    const treatment = matchedClass
      ? [
          matchedClass.priorityPercent ? `priority ${matchedClass.priorityPercent}%` : "",
          matchedClass.bandwidthPercent ? `bandwidth ${matchedClass.bandwidthPercent}%` : "",
          matchedClass.dscp ? `dscp ${matchedClass.dscp}` : "",
        ].filter(Boolean).join(", ") || "class matched"
      : "no class matched";
    reasons.push(`QoS ${direction.toUpperCase()} ${device.name}/${iface?.name}: ${policyName} ${matchedClass ? `class ${matchedClass.className}` : "default class"} (${treatment}).`);
    steps.push({
      kind: "qos",
      label: "QoS",
      detail: `${device.name}/${iface?.name || "interface"} applies ${policyName}: ${treatment}.`,
      status: "ok",
      deviceId: device.id,
    });
  }

  private isLinkOperational(link: Link): boolean {
    const from = this.lab.devices[link.from];
    const to = this.lab.devices[link.to];
    const fromIface = getInterface(from, link.fromIf);
    const toIface = getInterface(to, link.toIf);
    return Boolean(from && to && (!fromIface || fromIface.up) && (!toIface || toIface.up));
  }

  private getPeer(link: Link, deviceId: string): string | null {
    if (link.from === deviceId) return link.to;
    if (link.to === deviceId) return link.from;
    return null;
  }

  findLayer2Path(startDeviceId: string, endDeviceId: string, startInterface = "") {
    if (startDeviceId === endDeviceId) return { devicePath: [startDeviceId], linkPath: [] };
    const requiredStart = normalizeInterfaceName(startInterface);
    const queue = [{ id: startDeviceId, devicePath: [startDeviceId], linkPath: [] as string[] }];
    const visited = new Set([startDeviceId]);

    while (queue.length) {
      const current = queue.shift();
      if (!current) break;
      for (const link of this.lab.links) {
        if (!this.isLinkOperational(link)) continue;
        if (link.from !== current.id && link.to !== current.id) continue;
        const linkInterface = link.from === current.id ? link.fromIf : link.toIf;
        if (requiredStart && current.devicePath.length === 1 && normalizeInterfaceName(linkInterface) !== requiredStart) continue;
        const peer = this.getPeer(link, current.id);
        if (!peer || visited.has(peer)) continue;
        const next = { id: peer, devicePath: [...current.devicePath, peer], linkPath: [...current.linkPath, link.id] };
        if (peer === endDeviceId) return next;
        visited.add(peer);
        queue.push(next);
      }
    }
    return null;
  }

  private appendPath(pathState: { pathDevices: string[]; pathLinks: string[] }, segment: { devicePath: string[]; linkPath: string[] }, skipFirst = true) {
    const devices = skipFirst ? segment.devicePath.slice(1) : segment.devicePath;
    devices.forEach((id) => {
      if (pathState.pathDevices[pathState.pathDevices.length - 1] !== id) pathState.pathDevices.push(id);
    });
    segment.linkPath.forEach((id) => pathState.pathLinks.push(id));
  }

  private routingTable(router: Device) {
    const connected = configuredUpInterfaces(router).map((iface) => ({
      source: "connected",
      network: networkAddress(iface.ip, iface.mask),
      mask: iface.mask,
      prefix: maskToPrefix(iface.mask),
      nextHop: "",
      interface: iface.name,
      metric: 0,
    }));
    const statics = router.staticRoutes
      .filter((route) => isValidIp(route.network) && isValidMask(route.mask) && (isValidIp(route.nextHop) || route.interface))
      .map((route) => ({
        source: "static",
        network: networkAddress(route.network, route.mask),
        mask: route.mask,
        prefix: maskToPrefix(route.mask),
        nextHop: route.nextHop,
        interface: route.interface || "",
        metric: route.metric || 1,
      }));
    return [...connected, ...statics, ...this.dynamicRoutes(router)];
  }

  private routingProcesses(router: Device, protocol?: RoutingProtocol): DynamicRoutingProcess[] {
    return (router.dynamicRouting || []).filter((process) => !protocol || process.protocol === protocol);
  }

  private advertisedNetworks(router: Device, process: DynamicRoutingProcess) {
    const configured = process.networks || [];
    if (!configured.length) return [];
    return configuredUpInterfaces(router)
      .filter((iface) => configured.some((item) => dynamicNetworkMatchesInterface(item, iface)))
      .map((iface) => ({
        network: networkAddress(iface.ip, iface.mask),
        mask: iface.mask,
        prefix: maskToPrefix(iface.mask),
        interface: iface.name,
      }));
  }

  private dynamicNeighbors(router: Device, process: DynamicRoutingProcess) {
    const localAdvertised = this.advertisedNetworks(router, process);
    if (!localAdvertised.length) return [];
    const result: Array<{ router: Device; localIface: NetworkInterface; remoteIface: NetworkInterface }> = [];
    configuredUpInterfaces(router).forEach((localIface) => {
      if ((process.passiveInterfaces || []).some((name) => normalizeInterfaceName(name) === normalizeInterfaceName(localIface.name))) return;
      if (!localAdvertised.some((network) => network.interface === localIface.name)) return;
      Object.values(this.lab.devices).forEach((candidate) => {
        if (candidate.id === router.id || !isRoutingDevice(candidate)) return;
        const peerProcess = this.routingProcesses(candidate).find((item) => routingProcessKey(item) === routingProcessKey(process));
        if (!peerProcess || !this.advertisedNetworks(candidate, peerProcess).length) return;
        configuredUpInterfaces(candidate).forEach((remoteIface) => {
          if ((peerProcess.passiveInterfaces || []).some((name) => normalizeInterfaceName(name) === normalizeInterfaceName(remoteIface.name))) return;
          if (!ipInSubnet(remoteIface.ip, networkAddress(localIface.ip, localIface.mask), localIface.mask)) return;
          if (!this.findLayer2Path(router.id, candidate.id, localIface.name)) return;
          result.push({ router: candidate, localIface, remoteIface });
        });
      });
    });
    return result;
  }

  private dynamicRoutes(router: Device) {
    const routes: Array<{ source: RoutingProtocol; network: string; mask: string; prefix: number; nextHop: string; interface: string; metric: number }> = [];
    const connectedKeys = new Set(configuredUpInterfaces(router).map((iface) => `${networkAddress(iface.ip, iface.mask)}/${iface.mask}`));
    this.routingProcesses(router).forEach((process) => {
      const visited = new Set<string>([router.id]);
      const queue = this.dynamicNeighbors(router, process).map((neighbor) => ({
        router: neighbor.router,
        firstHopIp: neighbor.remoteIface.ip,
        firstHopInterface: neighbor.localIface.name,
        metric: 1,
      }));

      while (queue.length) {
        const current = queue.shift();
        if (!current || visited.has(current.router.id)) continue;
        visited.add(current.router.id);
        const remoteProcess = this.routingProcesses(current.router).find((item) => routingProcessKey(item) === routingProcessKey(process));
        if (!remoteProcess) continue;

        this.advertisedNetworks(current.router, remoteProcess).forEach((network) => {
          const key = `${network.network}/${network.mask}`;
          if (connectedKeys.has(key)) return;
          if (routes.some((route) => route.network === network.network && route.mask === network.mask && route.source === process.protocol)) return;
          routes.push({
            source: process.protocol,
            network: network.network,
            mask: network.mask,
            prefix: network.prefix,
            nextHop: current.firstHopIp,
            interface: current.firstHopInterface,
            metric: current.metric,
          });
        });

        this.dynamicNeighbors(current.router, remoteProcess).forEach((neighbor) => {
          if (visited.has(neighbor.router.id)) return;
          queue.push({
            router: neighbor.router,
            firstHopIp: current.firstHopIp,
            firstHopInterface: current.firstHopInterface,
            metric: current.metric + 1,
          });
        });
      }
    });
    return routes;
  }

  lookupRoute(router: Device, destinationIp: string) {
    return this.routingTable(router)
      .filter((route) => ipInSubnet(destinationIp, route.network, route.mask))
      .sort((a, b) => b.prefix - a.prefix || a.metric - b.metric)[0] || null;
  }

  private resolveEgress(router: Device, route: ReturnType<Simulator["lookupRoute"]>, destinationIp: string): NetworkInterface | null {
    if (!route) return null;
    if (route.interface) {
      const iface = getInterface(router, route.interface);
      if (iface) return iface;
    }
    if (route.nextHop) {
      return configuredUpInterfaces(router).find((iface) => ipInSubnet(route.nextHop, networkAddress(iface.ip, iface.mask), iface.mask)) || null;
    }
    return configuredUpInterfaces(router).find((iface) => ipInSubnet(destinationIp, networkAddress(iface.ip, iface.mask), iface.mask)) || null;
  }

  private resolveNextHop(router: Device, egress: NetworkInterface, route: ReturnType<Simulator["lookupRoute"]>, targetEntry: { device: Device; iface: NetworkInterface } | null) {
    if (route?.nextHop) return this.findDeviceByIp(route.nextHop);
    if (targetEntry && ipInSubnet(targetEntry.iface.ip, networkAddress(egress.ip, egress.mask), egress.mask)) return targetEntry;

    const candidates: Array<{ device: Device; iface: NetworkInterface }> = [];
    Object.values(this.lab.devices).forEach((device) => {
      if (device.id === router.id) return;
      device.interfaces.forEach((iface) => {
        if (iface.up && isValidIp(iface.ip) && ipInSubnet(iface.ip, networkAddress(egress.ip, egress.mask), egress.mask)) {
          candidates.push({ device, iface });
        }
      });
    });
    candidates.sort((a, b) => Number(isRoutingDevice(b.device)) - Number(isRoutingDevice(a.device)) || a.device.name.localeCompare(b.device.name));
    return candidates[0] || null;
  }

  private applyNat(router: Device, ingress: NetworkInterface | null, egress: NetworkInterface, packet: { protocol: Protocol; srcIp: string; dstIp: string; port?: number | null }, reasons: string[], steps: FlowStep[]) {
    if (!(isPrivateIp(packet.srcIp) && !isPrivateIp(packet.dstIp))) return { ok: true, message: "" };
    if (ingress?.natRole !== "inside" || egress.natRole !== "outside") {
      steps.push({ kind: "nat", label: "NAT/PAT", detail: `${router.name}: inside/outside roles are missing.`, status: "bad", deviceId: router.id });
      return { ok: false, message: "inside/outside roles are missing" };
    }
    const rule = router.nat.overloadRules.find((candidate) => {
      if (normalizeInterfaceName(candidate.interface) !== normalizeInterfaceName(egress.name)) return false;
      return this.evaluateAcl(router, candidate.aclName, packet).permitted;
    });
    if (!rule) {
      steps.push({ kind: "nat", label: "NAT/PAT", detail: `${router.name}: PAT overload rule or ACL does not match.`, status: "bad", deviceId: router.id });
      return { ok: false, message: "PAT overload rule or ACL does not match" };
    }
    if (!isValidIp(egress.ip)) {
      steps.push({ kind: "nat", label: "NAT/PAT", detail: `${router.name}: outside interface has no IP.`, status: "bad", deviceId: router.id });
      return { ok: false, message: "outside interface has no IP" };
    }
    const existing = router.nat.translations.find((entry) => entry.protocol === packet.protocol && entry.insideLocal === packet.srcIp && entry.outsideGlobal === packet.dstIp);
    const translation: NatTranslation = existing || {
      protocol: packet.protocol,
      insideLocal: packet.srcIp,
      insideGlobal: egress.ip,
      outsideLocal: packet.dstIp,
      outsideGlobal: packet.dstIp,
      patPort: router.nat.nextPort++,
      egressInterface: egress.name,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    };
    if (!existing) router.nat.translations.push(translation);
    translation.lastUsedAt = new Date().toISOString();
    packet.srcIp = translation.insideGlobal;
    reasons.push(`NAT/PAT translated ${translation.insideLocal} to ${translation.insideGlobal}:${translation.patPort}.`);
    steps.push({
      kind: "nat",
      label: "NAT/PAT",
      detail: `${router.name} translated ${translation.insideLocal} to ${translation.insideGlobal}:${translation.patPort}.`,
      status: "ok",
      deviceId: router.id,
    });
    return { ok: true, message: "" };
  }

  analyzeConnectivity(sourceDeviceId: string, targetIp: string, protocol: Protocol = "icmp", port: number | null = null): ConnectivityResult {
    const source = this.lab.devices[sourceDeviceId];
    const reasons: string[] = [];
    const steps: FlowStep[] = [];
    const hops: string[] = source ? [source.name] : [];
    const pathState = { pathDevices: source ? [source.id] : [], pathLinks: [] as string[] };
    let current: Device | null = source || null;
    const fail = (message: string, deviceId = current?.id || source?.id): ConnectivityResult => {
      steps.push({
        kind: "drop",
        label: "Drop",
        detail: message.replace(/^% ?/, ""),
        status: "bad",
        deviceId,
      });
      return { ok: false, message, reasons, hops, targetFound: false, pathDevices: pathState.pathDevices, pathLinks: pathState.pathLinks, steps };
    };
    const addLayer2Step = (segment: { devicePath: string[]; linkPath: string[] }, label: string) => {
      const names = segment.devicePath.map((id) => this.lab.devices[id]?.name || id);
      const switchId = segment.devicePath.find((id) => this.lab.devices[id]?.type === "switch");
      steps.push({
        kind: "switch",
        label,
        detail: `Layer-2 path ${names.join(" -> ")} over ${segment.linkPath.length} cable(s).`,
        status: "ok",
        deviceId: switchId || segment.devicePath[0],
        linkId: segment.linkPath[0],
      });
    };
    const succeed = (): ConnectivityResult => ({ ok: true, message: "", reasons, hops, targetFound: true, pathDevices: pathState.pathDevices, pathLinks: pathState.pathLinks, steps });

    if (!source) return fail("Select a source device first.");
    if (!isValidIp(targetIp)) return fail("% Invalid IP address.");

    const targetEntry = this.findDeviceByIp(targetIp);
    const packet = { protocol, srcIp: "", dstIp: targetIp, port: port || (protocol === "tcp" ? 80 : protocol === "udp" ? 53 : null) };
    let ingress: NetworkInterface | null = null;

    if (!isRoutingDevice(source)) {
      const sourceIface = source.interfaces[0];
      if (!sourceIface?.up) return fail(`% Interface ${sourceIface?.name || "eth0"} is shutdown.`);
      if (!isValidIp(sourceIface.ip) || !normalizeMask(sourceIface.mask)) return fail("% Source endpoint is not configured with IP/mask.");
      packet.srcIp = sourceIface.ip;
      reasons.push(`${source.name}/${sourceIface.name} is ${sourceIface.ip}/${maskToPrefix(sourceIface.mask)}.`);
      steps.push({
        kind: "source",
        label: "Source",
        detail: `${source.name}/${sourceIface.name} sends ${protocol.toUpperCase()} from ${packet.srcIp} to ${targetIp}.`,
        status: "ok",
        deviceId: source.id,
      });

      if (targetEntry && ipInSubnet(targetIp, networkAddress(sourceIface.ip, sourceIface.mask), sourceIface.mask)) {
        reasons.push(`${targetIp} is inside the source subnet.`);
        steps.push({ kind: "route", label: "Local subnet", detail: `${targetIp} is directly reachable from ${source.name}.`, status: "ok", deviceId: source.id });
        const segment = this.findLayer2Path(source.id, targetEntry.device.id, sourceIface.name);
        if (!segment) return fail("Local subnet exists but Layer-2 path is down.");
        this.appendPath(pathState, segment, false);
        addLayer2Step(segment, "Switching");
        hops.push(targetEntry.device.name);
        steps.push({ kind: "destination", label: "Destination", detail: `${targetEntry.device.name}/${targetEntry.iface.name} owns ${targetIp}.`, status: "ok", deviceId: targetEntry.device.id });
        return succeed();
      }

      if (!isValidIp(source.gateway)) return fail(`% Route missing for ${targetIp}. Default gateway is not set.`);
      const gateway = this.findDeviceByIp(source.gateway);
      if (!gateway?.iface.up) return fail(`% Route missing for ${targetIp}. Gateway ${source.gateway} is unreachable.`);
      if (!ipInSubnet(source.gateway, networkAddress(sourceIface.ip, sourceIface.mask), sourceIface.mask)) return fail(`% Route missing for ${targetIp}. Gateway is outside local subnet.`);
      const segment = this.findLayer2Path(source.id, gateway.device.id, sourceIface.name);
      if (!segment) return fail(`% Route missing for ${targetIp}. No Layer-2 path to gateway.`);
      this.appendPath(pathState, segment, false);
      addLayer2Step(segment, "Gateway L2");
      current = gateway.device;
      ingress = gateway.iface;
      hops.push(gateway.device.name);
      steps.push({
        kind: "gateway",
        label: "Gateway",
        detail: `${source.name} forwards to ${gateway.device.name}/${gateway.iface.name} at ${source.gateway}.`,
        status: "ok",
        deviceId: gateway.device.id,
      });
    } else {
      const sourceIface = configuredUpInterfaces(source)[0];
      if (!sourceIface) return fail(`% Interface ${source.interfaces[0]?.name || "interface"} is shutdown.`);
      packet.srcIp = sourceIface.ip;
      steps.push({
        kind: "source",
        label: "Source",
        detail: `${source.name}/${sourceIface.name} originates ${protocol.toUpperCase()} from ${packet.srcIp}.`,
        status: "ok",
        deviceId: source.id,
      });
    }

    const visited = new Set<string>();
    for (let step = 0; step < 14; step += 1) {
      if (!current) return fail("% Route missing: current device is unresolved.");
      const signature = `${current.id}:${packet.srcIp}:${packet.dstIp}`;
      if (visited.has(signature)) return fail("% Routing loop detected.");
      visited.add(signature);

      if (targetEntry && current.id === targetEntry.device.id) {
        steps.push({ kind: "destination", label: "Destination", detail: `${targetEntry.device.name}/${targetEntry.iface.name} owns ${targetIp}.`, status: "ok", deviceId: targetEntry.device.id });
        return succeed();
      }
      if (!isRoutingDevice(current)) return fail(`% Transit failed: ${current.name} cannot route packets.`);
      if (ingress) this.applyQos(current, ingress, "in", packet, reasons, steps);
      if (ingress && !this.applyAcl(current, ingress, "in", packet, reasons, steps)) return fail(`% ACL deny on ${current.name} ${ingress.name} inbound.`, current.id);

      const route = this.lookupRoute(current, targetIp);
      if (!route) return fail(`% Route missing for ${targetIp}.`);
      const egress = this.resolveEgress(current, route, targetIp);
      if (!egress) return fail(`% Route missing for ${targetIp}. Next hop/interface unresolved.`);
      if (!egress.up) return fail(`% Interface ${egress.name} is shutdown.`);
      const routeDetail = route.source === "connected"
        ? `${current.name} uses connected ${route.network}/${route.prefix} on ${egress.name}.`
        : `${current.name} routes ${targetIp} via ${route.nextHop || route.interface || egress.name}.`;
      reasons.push(routeDetail);
      steps.push({ kind: "route", label: "Route", detail: routeDetail, status: "ok", deviceId: current.id });
      this.applyQos(current, egress, "out", packet, reasons, steps);
      if (!this.applyAcl(current, egress, "out", packet, reasons, steps)) return fail(`% ACL deny on ${current.name} ${egress.name} outbound.`, current.id);

      const nat = this.applyNat(current, ingress, egress, packet, reasons, steps);
      if (!nat.ok) return fail(`% NAT failure: ${nat.message}`);

      const nextHop = this.resolveNextHop(current, egress, route, targetEntry);
      if (!nextHop) return fail(`% Route missing for ${targetIp}. Next hop is unreachable.`);
      const segment = this.findLayer2Path(current.id, nextHop.device.id, egress.name);
      if (!segment) return fail(`% Interface path down between ${current.name} and ${nextHop.device.name}.`);
      this.appendPath(pathState, segment, true);
      addLayer2Step(segment, "Forwarding");
      if (hops[hops.length - 1] !== nextHop.device.name) hops.push(nextHop.device.name);
      if (targetEntry && nextHop.device.id === targetEntry.device.id) {
        steps.push({ kind: "destination", label: "Destination", detail: `${targetEntry.device.name}/${targetEntry.iface.name} owns ${targetIp}.`, status: "ok", deviceId: targetEntry.device.id });
        return succeed();
      }
      ingress = nextHop.iface;
      current = nextHop.device;
    }

    return fail("% Traceroute exceeded max hops.");
  }

  recordFlow(mode: string, source: Device | null, target: string, result: ConnectivityResult): FlowState {
    const flow = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      mode,
      sourceName: source?.name || "unknown",
      target,
      success: Boolean(result.ok && result.targetFound),
      pathDevices: result.pathDevices,
      pathLinks: result.pathLinks,
      reasons: result.reasons,
      steps: result.steps,
    };
    this.lab.lastFlow = flow;
    return flow;
  }

  decisionDetails(result: ConnectivityResult): string {
    const lines = ["Decision ladder:"];
    result.reasons.forEach((reason, index) => lines.push(` ${index + 1}. ${reason}`));
    if (result.hops.length) lines.push(`Path: ${result.hops.join(" -> ")}`);
    return lines.join("\n");
  }

  ping(sourceId: string, targetIp: string): string {
    const source = this.lab.devices[sourceId] || null;
    const result = this.analyzeConnectivity(sourceId, targetIp, "icmp");
    this.recordFlow("ping", source, targetIp, result);
    if (!result.ok) return [result.message, this.decisionDetails(result)].join("\n");
    addEvent(this.lab, `Ping success: ${source?.name || "device"} -> ${targetIp}`, "success");
    return [`Reply from ${targetIp}: bytes=32 time<1ms TTL=64 (simulated)`, this.decisionDetails(result)].join("\n");
  }

  traceroute(sourceId: string, targetIp: string): string {
    const source = this.lab.devices[sourceId] || null;
    const result = this.analyzeConnectivity(sourceId, targetIp, "icmp");
    this.recordFlow("traceroute", source, targetIp, result);
    if (!result.ok) return [result.message, this.decisionDetails(result)].join("\n");
    return [`Tracing route to ${targetIp}`, ...result.hops.map((hop, index) => `${index + 1}  ${hop}`), "Trace complete.", this.decisionDetails(result)].join("\n");
  }

  renewDhcp(deviceId: string): string {
    const endpoint = this.lab.devices[deviceId];
    if (!endpoint || !(endpoint.type === "pc" || endpoint.type === "server")) return "% DHCP renew is available for PC/Server only.";
    const iface = endpoint.interfaces[0] || { name: "eth0", ip: "", mask: "", up: true };
    if (!endpoint.interfaces[0]) endpoint.interfaces.push(iface);
    if (!iface.up) return `DHCP renew failed: interface ${iface.name} is shutdown.`;

    const pools: Array<{ server: Device; pool: DhcpPool }> = [];
    Object.values(this.lab.devices).forEach((device) => {
      if (device.type === "server" && !device.services.dhcp) return;
      device.dhcpPools.forEach((pool) => pools.push({ server: device, pool }));
    });
    if (!pools.length) return "DHCP renew failed: no DHCP pool configured.";

    for (const { server, pool } of pools) {
      const excluded = new Set<number>();
      [...server.dhcpExcluded, ...(pool.excludedRanges || [])].forEach((range) => {
        for (let cursor = ipToInt(range.start); cursor <= ipToInt(range.end); cursor += 1) excluded.add(cursor);
      });
      if (isValidIp(pool.defaultRouter)) excluded.add(ipToInt(pool.defaultRouter));
      const used = new Set(Object.values(this.lab.devices).flatMap((device) => device.interfaces.map((item) => item.ip)).filter(isValidIp).map(ipToInt));

      let selected = "";
      for (let cursor = ipToInt(pool.start || firstUsableIp(pool.network, pool.mask)); cursor <= ipToInt(pool.end || lastUsableIp(pool.network, pool.mask)); cursor += 1) {
        const candidate = intToIp(cursor);
        if (ipInSubnet(candidate, pool.network, pool.mask) && !excluded.has(cursor) && !used.has(cursor)) {
          selected = candidate;
          break;
        }
      }
      if (!selected) continue;
      iface.ip = selected;
      iface.mask = pool.mask;
      iface.up = true;
      endpoint.gateway = pool.defaultRouter;
      endpoint.dns = pool.dnsServer;
      server.dhcpBindings.push({ ip: selected, mask: pool.mask, gateway: pool.defaultRouter, dns: pool.dnsServer, client: endpoint.name, clientId: endpoint.id, pool: pool.name, leasedAt: new Date().toISOString() });
      addEvent(this.lab, `DHCP assigned ${selected} to ${endpoint.name} via ${server.name}.`, "success");
      return `${endpoint.name} DHCP lease acquired: ${selected} / ${pool.mask}, GW ${endpoint.gateway || "--"}, DNS ${endpoint.dns || "--"}`;
    }
    return "DHCP renew failed: all candidate pools are exhausted or excluded.";
  }

  resolveDomain(requester: Device, query: string) {
    if (isValidIp(query)) return { ok: true, ip: query, query, serverIp: requester.dns || "literal", message: "" };
    if (!isValidIp(requester.dns)) return { ok: false, ip: "", query, serverIp: "", message: "DNS server is not configured." };
    const dnsEntry = this.findDeviceByIp(requester.dns);
    if (!dnsEntry?.device.services.dns) return { ok: false, ip: "", query, serverIp: requester.dns, message: `DNS resolver ${requester.dns} is unavailable.` };
    const reachability = this.analyzeConnectivity(requester.id, requester.dns, "udp", 53);
    this.recordFlow("nslookup", requester, requester.dns, reachability);
    if (!reachability.ok || !reachability.targetFound) return { ok: false, ip: "", query, serverIp: requester.dns, message: [`DNS server ${requester.dns} is not reachable.`, this.decisionDetails(reachability)].join("\n") };
    const records = dnsEntry.device.dnsRecords as Record<string, string>;
    const key = Object.keys(records).find((recordName: string) => recordName.toLowerCase() === query.toLowerCase());
    if (!key) return { ok: false, ip: "", query, serverIp: requester.dns, message: `*** ${query}: Non-existent domain` };
    return { ok: true, ip: records[key], query, serverIp: requester.dns, message: "" };
  }

  curl(sourceId: string, targetHost: string): string {
    const source = this.lab.devices[sourceId];
    if (!source) return "Select a source device first.";
    const resolved = isValidIp(targetHost) ? { ok: true, ip: targetHost, message: "" } : this.resolveDomain(source, targetHost);
    if (!resolved.ok) return resolved.message;
    const route = this.analyzeConnectivity(sourceId, resolved.ip, "tcp", 80);
    this.recordFlow("curl", source, resolved.ip, route);
    if (!route.ok) return [route.message, this.decisionDetails(route)].join("\n");
    const target = this.findDeviceByIp(resolved.ip);
    if (!target?.device.services.http) return `curl: HTTP service unavailable at ${targetHost}`;
    return ["HTTP/1.1 200 OK", `Server: ${target.device.name}`, "Content-Type: text/plain", "", target.device.httpContent || `Welcome to ${target.device.name} (simulated response).`].join("\n");
  }

  sendMail(sourceId: string, targetHost: string, to: string, body: string): string {
    const source = this.lab.devices[sourceId];
    if (!source) return "Select a source device first.";
    if (!to) return "% Incomplete command. Usage: mail send <server-or-domain> <user> <message>";
    const resolved = isValidIp(targetHost) ? { ok: true, ip: targetHost, message: "" } : this.resolveDomain(source, targetHost);
    if (!resolved.ok) return resolved.message;
    const route = this.analyzeConnectivity(sourceId, resolved.ip, "tcp", 25);
    this.recordFlow("mail", source, resolved.ip, route);
    if (!route.ok) return [route.message, this.decisionDetails(route)].join("\n");
    const target = this.findDeviceByIp(resolved.ip);
    if (!target?.device.services.mail) return `mail: SMTP service unavailable at ${targetHost}`;
    if (!target.device.mailboxes[to]) target.device.mailboxes[to] = [];
    target.device.mailboxes[to].push({
      from: source.name,
      to,
      body: body || "(empty)",
      receivedAt: new Date().toISOString(),
    });
    addEvent(this.lab, `Mail delivered from ${source.name} to ${to} on ${target.device.name}.`, "success");
    return `250 OK: queued mail for ${to} on ${target.device.name}`;
  }

  routeTableText(device: Device): string {
    const rows = this.routingTable(device).sort((a, b) => b.prefix - a.prefix);
    if (!rows.length) return "% Route table empty.";
    return rows.map((route) => {
      if (route.source === "connected") return `C ${route.network}/${route.prefix} is directly connected, ${route.interface}`;
      if (route.source === "static") {
        const target = route.nextHop ? `via ${route.nextHop}` : route.interface ? `via ${route.interface}` : "via unresolved";
        return `S ${route.network}/${route.prefix} [1/0] ${route.interface && route.nextHop ? `${target}, ${route.interface}` : target}`;
      }
      const code = route.source === "rip" ? "R" : "D";
      return `${code} ${route.network}/${route.prefix} [${route.metric}/0] via ${route.nextHop || "unresolved"}, ${route.interface}`;
    }).join("\n");
  }
}

export function interfaceText(device: Device): string {
  return device.interfaces.map(formatInterface).join("\n");
}
