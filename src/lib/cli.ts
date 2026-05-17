import type { AclEndpoint, AclEntry, Device, DynamicRoutingProcess, LabState, Protocol, QosPolicyClass, RoutingProtocol } from "../types";
import { getInterface, isValidIp, isValidMask, networkAddress, normalizeInterfaceName } from "./ip";
import { addEvent, interfaceText, selectedDevice, Simulator } from "./simulator";

const IP_ROUTE_USAGE = "ip route <network> <mask> <next-hop|interface> [next-hop]";

function matches(token: string | undefined, full: string, min = 1): boolean {
  return Boolean(token && token.length >= min && full.startsWith(token.toLowerCase()));
}

function findInterface(device: Device, name: string) {
  return getInterface(device, name);
}

function findAcl(device: Device, name: string) {
  const key = Object.keys(device.acls).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? { key, acl: device.acls[key] } : null;
}

function ensureAcl(device: Device, name: string) {
  const existing = findAcl(device, name);
  if (existing) return existing;
  device.acls[name] = { name, type: "extended", entries: [] };
  return { key: name, acl: device.acls[name] };
}

function routingKey(protocol: RoutingProtocol, processId = "") {
  return `${protocol}:${protocol === "rip" ? "rip" : processId || "1"}`;
}

function findRoutingProcess(device: Device, key: string): DynamicRoutingProcess | null {
  return device.dynamicRouting.find((process) => routingKey(process.protocol, process.processId) === key) || null;
}

function ensureRoutingProcess(device: Device, protocol: RoutingProtocol, processId = "") {
  const key = routingKey(protocol, processId);
  const existing = findRoutingProcess(device, key);
  if (existing) return existing;
  const created: DynamicRoutingProcess = {
    protocol,
    processId: protocol === "rip" ? "rip" : processId || "1",
    networks: [],
    version: protocol === "rip" ? 2 : undefined,
    noAutoSummary: false,
    passiveInterfaces: [],
  };
  device.dynamicRouting.push(created);
  return created;
}

function ensureQosClass(device: Device, name: string, matchType: "all" | "any" = "any") {
  if (!device.qos.classMaps[name]) device.qos.classMaps[name] = { name, matchType, matches: [] };
  return device.qos.classMaps[name];
}

function ensureQosPolicy(device: Device, name: string) {
  if (!device.qos.policyMaps[name]) device.qos.policyMaps[name] = { name, classes: [] };
  return device.qos.policyMaps[name];
}

function ensurePolicyClass(device: Device, policyName: string | null, className: string | null): QosPolicyClass | null {
  if (!policyName || !className) return null;
  const policy = ensureQosPolicy(device, policyName);
  let policyClass = policy.classes.find((item) => item.className.toLowerCase() === className.toLowerCase());
  if (!policyClass) {
    policyClass = { className };
    policy.classes.push(policyClass);
  }
  return policyClass;
}

function staticRouteLine(route: Device["staticRoutes"][number]): string {
  return ["ip route", route.network, route.mask, route.interface || "", route.nextHop || ""].filter(Boolean).join(" ");
}

export function isTerminalClearCommand(rawCommand: string): boolean {
  const command = rawCommand.trim().toLowerCase();
  return command === "clear" || command === "cls";
}

export function cliPrompt(lab: LabState): string {
  const device = selectedDevice(lab);
  if (!device) return "Trainer>";
  if (!(device.type === "router" || device.type === "switch")) return `${device.name}>`;
  const mode = device.cli.mode;
  if (mode === "privileged") return `${device.name}#`;
  if (mode === "config") return `${device.name}(config)#`;
  if (mode === "interface") return `${device.name}(config-if)#`;
  if (mode === "dhcp") return `${device.name}(dhcp-config)#`;
  if (mode === "acl") return `${device.name}(config-ext-nacl)#`;
  if (mode === "routing") return `${device.name}(config-router)#`;
  if (mode === "class-map") return `${device.name}(config-cmap)#`;
  if (mode === "policy-map") return `${device.name}(config-pmap)#`;
  return `${device.name}>`;
}

export function pushHistory(device: Device, command: string) {
  if (!command) return;
  if (device.cli.history[device.cli.history.length - 1] !== command) device.cli.history.push(command);
  if (device.cli.history.length > 120) device.cli.history.shift();
  device.cli.historyCursor = null;
  device.cli.historyDraft = "";
}

export function navigateHistory(device: Device | null, direction: -1 | 1, currentValue: string): string | null {
  if (!device || !device.cli.history.length) return null;
  if (device.cli.historyCursor === null) {
    device.cli.historyCursor = device.cli.history.length;
    device.cli.historyDraft = currentValue;
  }
  device.cli.historyCursor = Math.max(0, Math.min(device.cli.history.length, device.cli.historyCursor + direction));
  if (device.cli.historyCursor === device.cli.history.length) return device.cli.historyDraft || "";
  return device.cli.history[device.cli.historyCursor] || "";
}

export function runCliCommand(lab: LabState, rawCommand: string): string {
  const command = rawCommand.trim();
  if (!command) return "";
  const tokens = command.split(/\s+/);
  const lower = tokens.map((token) => token.toLowerCase());

  if (matches(lower[0], "select", 2)) {
    if (!tokens[1]) return "% Incomplete command. Usage: select <deviceName>";
    const query = tokens.slice(1).join(" ").toLowerCase();
    const target = Object.values(lab.devices).find((device) => device.id.toLowerCase() === query || device.name.toLowerCase() === query);
    if (!target) return `Device '${tokens.slice(1).join(" ")}' not found.`;
    lab.selectedDeviceId = target.id;
    addEvent(lab, `Selected device: ${target.name}`);
    return `Selected ${target.name}.`;
  }

  const device = selectedDevice(lab);
  if (!device) return "Select a device first.";
  if (isTerminalClearCommand(command)) return "";
  if (command === "?" || command.endsWith(" ?")) return suggestionText(commandSuggestions(lab, command));
  if (matches(lower[0], "help")) return helpText(device);

  if (!(device.type === "router" || device.type === "switch")) return endpointCommand(lab, device, tokens, lower);
  return networkCommand(lab, device, tokens, lower);
}

function helpText(device: Device): string {
  if (!(device.type === "router" || device.type === "switch")) {
    return [
      "PC/Server commands:",
      "  ipconfig",
      "  ipconfig /renew",
      "  ping <ip>",
      "  tracert <ip>",
      "  nslookup <domain>",
      "  curl <domain-or-ip>",
      "  service dns|http|www|mail enable",
      "  dhcp pool <name> <network> <mask> <gateway> <dns> [start] [end]",
      "  dns record <domain> <ip>",
      "  www content <text>",
      "  mail user <user>",
      "  mail send <server-or-domain> <user> <message>",
      "  show services | show mail",
      "  clear | cls",
      "  ?",
      "  select <deviceName>",
    ].join("\n");
  }
  return [
    "IOS-like commands:",
    "  enable | en",
    "  configure terminal | conf t",
    "  interface <name> | int g0/0",
    "  ip address <ip> <mask>",
    "  no shutdown | shutdown",
    `  ${IP_ROUTE_USAGE}`,
    "  router rip | router eigrp <asn> | router egrip <asn>",
    "  network <network> [wildcard]",
    "  ip dhcp excluded-address <start> [end]",
    "  ip dhcp pool <name>",
    "  ip access-list extended <name>",
    "  ip nat inside source list <acl> interface <if> overload",
    "  mls qos | class-map <name> | policy-map <name>",
    "  show running-config | show running-config interface <if>",
    "  show interfaces description | show ip interface brief | show ip route | show ip protocols",
    "  clear | cls | ?",
  ].join("\n");
}

function baseSuggestions(device: Device | null): string[] {
  if (!device) return ["select <deviceName>", "help", "?", "clear", "cls"];
  const common = ["select <deviceName>", "help", "?", "clear", "cls"];
  const interfaceTargets = device.interfaces.flatMap((iface) => [
    `interface ${iface.name}`,
    `int ${iface.name}`,
    `show running-config interface ${iface.name}`,
    `sh run int ${iface.name}`,
  ]);
  if (!(device.type === "router" || device.type === "switch")) {
    return [
      "ipconfig",
      "ipconfig /renew",
      "ping <ip>",
      "tracert <ip>",
      "nslookup <domain>",
      "curl <domain-or-ip>",
      "service dns enable",
      "service http enable",
      "service mail enable",
      "dhcp pool <name> <network> <mask> <gateway> <dns> [start] [end]",
      "dns record <domain> <ip>",
      "www content <text>",
      "mail user <user>",
      "mail send <server-or-domain> <user> <message>",
      "show services",
      "show mail",
      ...common,
    ];
  }

  if (device.cli.mode === "user") {
    return [
      "enable",
      ...interfaceTargets.filter((candidate) => candidate.startsWith("show") || candidate.startsWith("sh")),
      "show running-config",
      "show running-config interface <if>",
      "show ip interface brief",
      "show interfaces description",
      "ping <ip>",
      "traceroute <ip>",
      ...common,
    ];
  }

  const showCommands = [
    "show running-config",
    "show running-config interface <if>",
    "show ip interface brief",
    "show interfaces description",
      "show ip route",
      "show ip protocols",
      "show policy-map",
      "show class-map",
      "show access-lists",
    "show ip dhcp binding",
    "show ip nat translations",
  ];

  if (device.cli.mode === "privileged") {
    return [
      "configure terminal",
      "write memory",
      "ping <ip>",
      "traceroute <ip>",
      ...interfaceTargets.filter((candidate) => candidate.startsWith("show") || candidate.startsWith("sh")),
      ...showCommands,
      ...common,
    ];
  }
  if (device.cli.mode === "config") {
    return [
      "hostname <name>",
      ...interfaceTargets.filter((candidate) => candidate.startsWith("interface") || candidate.startsWith("int")),
      "interface <name>",
      "ip address <ip> <mask>",
      IP_ROUTE_USAGE,
      "router rip",
      "router eigrp <asn>",
      "router egrip <asn>",
      "ip dhcp excluded-address <start> [end]",
      "ip dhcp pool <name>",
      "ip access-list extended <name>",
      "ip nat inside source list <acl> interface <if> overload",
      "mls qos",
      "class-map match-any <name>",
      "policy-map <name>",
      "do show running-config",
      "do show ip interface brief",
      "end",
      "exit",
      ...common,
    ];
  }
  if (device.cli.mode === "interface") {
    return [
      ...interfaceTargets.filter((candidate) => candidate.startsWith("interface") || candidate.startsWith("int")),
      "description <text>",
      "ip address <ip> <mask>",
      "ip helper-address <ip>",
      "ip access-group <name> in",
      "ip access-group <name> out",
      "ip nat inside",
      "ip nat outside",
      "service-policy input <policy>",
      "service-policy output <policy>",
      "no shutdown",
      "no sh",
      "shutdown",
      "do show running-config interface <if>",
      "end",
      "exit",
      ...common,
    ];
  }
  if (device.cli.mode === "dhcp") {
    return ["network <network> <mask>", "default-router <ip>", "dns-server <ip>", "do show ip dhcp binding", "end", "exit", ...common];
  }
  if (device.cli.mode === "acl") {
    return ["permit ip any any", "permit tcp <src> <wildcard> <dst> <wildcard> eq <port>", "deny tcp <src> <wildcard> <dst> <wildcard> eq <port>", "no 10", "do show access-lists", "end", "exit", ...common];
  }
  if (device.cli.mode === "routing") {
    return ["network <network> [wildcard]", "version 2", "no auto-summary", "passive-interface <if>", "do show ip protocols", "do show ip route", "end", "exit", ...common];
  }
  if (device.cli.mode === "class-map") {
    return ["match protocol <name>", "match access-group name <acl>", "end", "exit", ...common];
  }
  if (device.cli.mode === "policy-map") {
    return ["class <name>", "priority percent <value>", "bandwidth percent <value>", "set dscp <value>", "end", "exit", ...common];
  }
  return common;
}

export function commandSuggestions(lab: LabState, rawInput = ""): string[] {
  const device = selectedDevice(lab);
  const query = rawInput.replace(/\?\s*$/, "").trim().toLowerCase();
  const suggestions = baseSuggestions(device);
  if (!query) return suggestions;
  return suggestions.filter((candidate) => candidate.toLowerCase().startsWith(query));
}

function suggestionText(suggestions: string[]): string {
  if (!suggestions.length) return "No matching commands. Type 'help' for the supported command set.";
  return ["Possible commands:", ...suggestions.map((item) => `  ${item}`)].join("\n");
}

export function completeCliCommand(lab: LabState, rawInput: string): { value?: string; message?: string } {
  const leadingWhitespace = rawInput.match(/^\s*/)?.[0] || "";
  const trimmed = rawInput.trimStart();
  const suggestions = commandSuggestions(lab, trimmed);
  if (!trimmed) return { message: suggestionText(suggestions) };
  if (suggestions.length === 1) {
    const value = `${leadingWhitespace}${suggestions[0]}`;
    return { value: value.endsWith(">") ? value : `${value} ` };
  }
  return { message: suggestionText(suggestions) };
}

function endpointCommand(lab: LabState, device: Device, tokens: string[], lower: string[]): string {
  const simulator = new Simulator(lab);
  if (lower[0] === "ipconfig") {
    if (lower[1] === "/renew") return simulator.renewDhcp(device.id);
    if (lower[1]) return "Unknown ipconfig option. Supported: ipconfig, ipconfig /renew";
    const iface = device.interfaces[0];
    return [
      `${device.name} IP Configuration`,
      `  Interface: ${iface?.name || "eth0"}`,
      `  Status: ${iface?.up ? "up" : "down"}`,
      `  IP Address: ${iface?.ip || "0.0.0.0"}`,
      `  Subnet Mask: ${iface?.mask || "0.0.0.0"}`,
      `  Default Gateway: ${device.gateway || "0.0.0.0"}`,
      `  DNS Server: ${device.dns || "0.0.0.0"}`,
    ].join("\n");
  }
  if (lower[0] === "ping") {
    if (!tokens[1]) return "% Incomplete command. Usage: ping <ip>";
    if (!isValidIp(tokens[1])) return "% Invalid IP address.";
    return simulator.ping(device.id, tokens[1]);
  }
  if (lower[0] === "tracert") {
    if (!tokens[1]) return "% Incomplete command. Usage: tracert <ip>";
    if (!isValidIp(tokens[1])) return "% Invalid IP address.";
    return simulator.traceroute(device.id, tokens[1]);
  }
  if (lower[0] === "nslookup") {
    if (!tokens[1]) return "% Incomplete command. Usage: nslookup <domain>";
    const resolved = simulator.resolveDomain(device, tokens[1]);
    if (!resolved.ok) return resolved.message;
    return [`Server: ${resolved.serverIp}`, `Name: ${resolved.query}`, `Address: ${resolved.ip}`].join("\n");
  }
  if (lower[0] === "curl") {
    if (!tokens[1]) return "% Incomplete command. Usage: curl <domain-or-ip>";
    return simulator.curl(device.id, tokens[1]);
  }
  if (lower[0] === "service") {
    const serviceName = normalizeServiceName(lower[1]);
    if (!serviceName || !["enable", "disable", "on", "off"].includes(lower[2] || "")) {
      return "% Incomplete command. Usage: service dns|http|www|mail|dhcp enable|disable";
    }
    device.services[serviceName] = lower[2] === "enable" || lower[2] === "on";
    return `${serviceName.toUpperCase()} service ${device.services[serviceName] ? "enabled" : "disabled"}.`;
  }
  if (lower[0] === "dhcp" && matches(lower[1], "pool", 2)) {
    if (matches(lower[2], "delete", 3)) {
      if (!tokens[3]) return "% Incomplete command. Usage: dhcp pool delete <name>";
      device.dhcpPools = device.dhcpPools.filter((pool) => pool.name.toLowerCase() !== tokens[3].toLowerCase());
      return `DHCP pool ${tokens[3]} deleted.`;
    }
    if (!tokens[2] || !isValidIp(tokens[3]) || !isValidMask(tokens[4]) || !isValidIp(tokens[5]) || !isValidIp(tokens[6])) {
      return "% Incomplete command. Usage: dhcp pool <name> <network> <mask> <gateway> <dns> [start] [end]";
    }
    if (tokens[7] && !isValidIp(tokens[7])) return "% Invalid DHCP start IP.";
    if (tokens[8] && !isValidIp(tokens[8])) return "% Invalid DHCP end IP.";
    const pool = {
      name: tokens[2],
      network: networkAddress(tokens[3], tokens[4]),
      mask: tokens[4],
      defaultRouter: tokens[5],
      dnsServer: tokens[6],
      start: tokens[7] || "",
      end: tokens[8] || "",
      excludedRanges: [],
    };
    const index = device.dhcpPools.findIndex((item) => item.name.toLowerCase() === pool.name.toLowerCase());
    if (index >= 0) device.dhcpPools[index] = pool;
    else device.dhcpPools.push(pool);
    device.services.dhcp = true;
    return `DHCP pool ${pool.name} saved.`;
  }
  if (lower[0] === "dns" && matches(lower[1], "record", 3)) {
    if (!tokens[2] || !isValidIp(tokens[3])) return "% Incomplete command. Usage: dns record <domain> <ip>";
    device.dnsRecords[tokens[2].toLowerCase()] = tokens[3];
    device.services.dns = true;
    return `DNS record added: ${tokens[2].toLowerCase()} -> ${tokens[3]}`;
  }
  if ((lower[0] === "www" || lower[0] === "web" || lower[0] === "http") && matches(lower[1], "content", 3)) {
    device.httpContent = tokens.slice(2).join(" ") || `Welcome to ${device.name} (simulated response).`;
    device.services.http = true;
    return "WWW content saved.";
  }
  if (lower[0] === "mail" && matches(lower[1], "user", 2)) {
    if (!tokens[2]) return "% Incomplete command. Usage: mail user <user>";
    const user = tokens[2].toLowerCase();
    if (!device.mailboxes[user]) device.mailboxes[user] = [];
    device.services.mail = true;
    return `Mailbox ${user} ready.`;
  }
  if (lower[0] === "mail" && matches(lower[1], "clear", 2)) {
    if (!tokens[2]) return "% Incomplete command. Usage: mail clear <user>";
    device.mailboxes[tokens[2].toLowerCase()] = [];
    return `Mailbox ${tokens[2].toLowerCase()} cleared.`;
  }
  if (lower[0] === "mail" && matches(lower[1], "send", 2)) {
    if (!tokens[2] || !tokens[3]) return "% Incomplete command. Usage: mail send <server-or-domain> <user> <message>";
    return simulator.sendMail(device.id, tokens[2], tokens[3], tokens.slice(4).join(" "));
  }
  if (lower[0] === "show") {
    if (matches(lower[1], "services", 3)) return endpointServices(device);
    if (matches(lower[1], "mail", 3)) return endpointMail(device, tokens[2]);
  }
  return unknownCommand(tokens.join(" "), commandSuggestions(lab, tokens[0] || ""));
}

function networkCommand(lab: LabState, device: Device, tokens: string[], lower: string[]): string {
  const simulator = new Simulator(lab);
  const cli = device.cli;
  const verb = lower[0];

  const isShow = matches(verb, "show", 2) || verb === "sh";
  if (isShow) {
    if (cli.mode !== "user" && cli.mode !== "privileged") return "% Show commands from configuration mode require: do show ...";
    return showCommand(simulator, device, lower.slice(1));
  }

  if (verb === "do") {
    if (!["config", "interface", "dhcp", "acl", "routing", "class-map", "policy-map"].includes(cli.mode)) return "% 'do' is available only in configuration modes.";
    if (!(matches(lower[1], "show", 2) || lower[1] === "sh")) return "% Only 'do show ...' is supported.";
    return showCommand(simulator, device, lower.slice(2));
  }

  if (verb === "end") {
    cli.mode = "privileged";
    cli.currentInterface = null;
    cli.currentDhcpPool = null;
    cli.currentAcl = null;
    cli.currentRouting = null;
    cli.currentClassMap = null;
    cli.currentPolicyMap = null;
    cli.currentPolicyClass = null;
    return "";
  }

  if (verb === "exit") {
    if (["interface", "dhcp", "acl", "routing", "class-map", "policy-map"].includes(cli.mode)) cli.mode = "config";
    else if (cli.mode === "config") cli.mode = "privileged";
    else if (cli.mode === "privileged") cli.mode = "user";
    else return "% Already at user EXEC mode. Use 'enable' to enter privileged EXEC mode.";
    cli.currentInterface = null;
    cli.currentDhcpPool = null;
    cli.currentAcl = null;
    cli.currentRouting = null;
    cli.currentClassMap = null;
    cli.currentPolicyMap = null;
    cli.currentPolicyClass = null;
    return "";
  }

  if (cli.mode === "user") {
    if (matches(verb, "enable", 2)) {
      cli.mode = "privileged";
      return "";
    }
    if (verb === "ping") return tokens[1] && isValidIp(tokens[1]) ? simulator.ping(device.id, tokens[1]) : "% Incomplete or invalid ping command.";
    if (matches(verb, "traceroute", 5)) return tokens[1] && isValidIp(tokens[1]) ? simulator.traceroute(device.id, tokens[1]) : "% Incomplete or invalid traceroute command.";
    return "% Command requires privileged EXEC mode. Use 'enable'.";
  }

  if (cli.mode === "privileged") {
    if (verb === "wr" || matches(verb, "write", 2)) return "Building configuration... [OK]";
    if (matches(verb, "configure", 4) || verb === "conf") {
      if (!matches(lower[1], "terminal", 1)) return "% Incomplete command. Usage: configure terminal";
      cli.mode = "config";
      return "";
    }
    if (verb === "ping") return tokens[1] && isValidIp(tokens[1]) ? simulator.ping(device.id, tokens[1]) : "% Incomplete or invalid ping command.";
    if (matches(verb, "traceroute", 5)) return tokens[1] && isValidIp(tokens[1]) ? simulator.traceroute(device.id, tokens[1]) : "% Incomplete or invalid traceroute command.";
    return unknownCommand(tokens.join(" "), commandSuggestions(lab, tokens[0] || ""));
  }

  if (cli.mode === "config") return configCommand(device, tokens, lower);
  if (cli.mode === "interface") return interfaceCommand(device, tokens, lower);
  if (cli.mode === "dhcp") return dhcpCommand(device, tokens, lower);
  if (cli.mode === "acl") return aclCommand(device, tokens, lower);
  if (cli.mode === "routing") return routingCommand(device, tokens, lower);
  if (cli.mode === "class-map") return classMapCommand(device, tokens, lower);
  if (cli.mode === "policy-map") return policyMapCommand(device, tokens, lower);
  return `% Unknown command '${tokens.join(" ")}'.`;
}

function configCommand(device: Device, tokens: string[], lower: string[]): string {
  const verb = lower[0];
  if (matches(verb, "hostname", 3)) {
    if (!tokens[1]) return "% Incomplete command. Usage: hostname <name>";
    device.name = tokens[1];
    return "";
  }
  if (matches(verb, "interface", 3) || verb === "int") {
    if (!tokens[1]) return "% Incomplete command. Usage: interface <name>";
    const iface = findInterface(device, tokens[1]);
    if (!iface) return `% Unknown interface '${tokens[1]}'.`;
    device.cli.mode = "interface";
    device.cli.currentInterface = iface.name;
    return "";
  }
  if (matches(verb, "router", 3)) {
    const protocolToken = lower[1];
    const protocol: RoutingProtocol | null = protocolToken === "rip" ? "rip" : (protocolToken === "eigrp" || protocolToken === "egrip") ? "eigrp" : null;
    if (!protocol) return "% Incomplete command. Usage: router rip | router eigrp <asn>";
    const processId = protocol === "rip" ? "rip" : tokens[2] || "1";
    if (protocol === "eigrp" && !/^\d+$/.test(processId)) return "% EIGRP autonomous system must be a number.";
    ensureRoutingProcess(device, protocol, processId);
    device.cli.mode = "routing";
    device.cli.currentRouting = routingKey(protocol, processId);
    device.cli.currentInterface = null;
    device.cli.currentDhcpPool = null;
    device.cli.currentAcl = null;
    return "";
  }
  if (verb === "mls" && matches(lower[1], "qos", 3)) {
    device.qos.enabled = true;
    if (matches(lower[2], "trust", 2)) device.qos.trust = tokens[3] || "dscp";
    return "";
  }
  if (verb === "qos") {
    if (matches(lower[1], "enable", 2)) {
      device.qos.enabled = true;
      return "";
    }
    if (matches(lower[1], "trust", 2)) {
      device.qos.enabled = true;
      device.qos.trust = tokens[2] || "dscp";
      return "";
    }
    return "% Incomplete command. Usage: qos enable | qos trust dscp|cos";
  }
  if (matches(verb, "class-map", 5)) {
    const matchType = lower[1] === "match-all" ? "all" : "any";
    const name = lower[1] === "match-all" || lower[1] === "match-any" ? tokens[2] : tokens[1];
    if (!name) return "% Incomplete command. Usage: class-map [match-any|match-all] <name>";
    ensureQosClass(device, name, matchType);
    device.cli.mode = "class-map";
    device.cli.currentClassMap = name;
    return "";
  }
  if (matches(verb, "policy-map", 5)) {
    if (!tokens[1]) return "% Incomplete command. Usage: policy-map <name>";
    ensureQosPolicy(device, tokens[1]);
    device.cli.mode = "policy-map";
    device.cli.currentPolicyMap = tokens[1];
    device.cli.currentPolicyClass = null;
    return "";
  }
  if (verb !== "ip") return unknownCommand(tokens.join(" "), baseSuggestions(device).filter((candidate) => candidate.toLowerCase().startsWith(verb || "")));

  if (matches(lower[1], "route", 2)) {
    if (!tokens[2] || !tokens[3] || !tokens[4]) return `% Incomplete command. Usage: ${IP_ROUTE_USAGE}`;
    if (!isValidIp(tokens[2])) return "% Invalid IP address.";
    if (!isValidMask(tokens[3])) return "% Invalid subnet mask.";
    let nextHop = "";
    let interfaceName = "";
    const targetInterface = findInterface(device, tokens[4]);
    if (isValidIp(tokens[4])) {
      if (tokens[5]) return `% Invalid route. Usage: ${IP_ROUTE_USAGE}`;
      nextHop = tokens[4];
    } else if (targetInterface) {
      if (tokens[5] && !isValidIp(tokens[5])) return "% Invalid IP address.";
      if (tokens[6]) return `% Invalid route. Usage: ${IP_ROUTE_USAGE}`;
      interfaceName = targetInterface.name;
      nextHop = tokens[5] || "";
    } else {
      return `% Invalid next-hop or interface '${tokens[4]}'. Usage: ${IP_ROUTE_USAGE}`;
    }
    const network = networkAddress(tokens[2], tokens[3]);
    const existing = device.staticRoutes.find((route) => route.network === network && route.mask === tokens[3]);
    if (existing) {
      existing.nextHop = nextHop;
      existing.interface = interfaceName;
      existing.metric = 1;
    } else {
      device.staticRoutes.push({ network, mask: tokens[3], nextHop, interface: interfaceName, metric: 1 });
    }
    return "";
  }

  if (matches(lower[1], "dhcp", 2)) {
    if (matches(lower[2], "excluded-address", 2)) {
      if (!isValidIp(tokens[3]) || !isValidIp(tokens[4] || tokens[3])) return "% Invalid IP address.";
      device.dhcpExcluded.push({ start: tokens[3], end: tokens[4] || tokens[3] });
      return "";
    }
    if (matches(lower[2], "pool", 2)) {
      if (!tokens[3]) return "% Incomplete command. Usage: ip dhcp pool <name>";
      let pool = device.dhcpPools.find((item) => item.name.toLowerCase() === tokens[3].toLowerCase());
      if (!pool) {
        pool = { name: tokens[3], network: "", mask: "", defaultRouter: "", dnsServer: "", excludedRanges: [] };
        device.dhcpPools.push(pool);
      }
      device.cli.mode = "dhcp";
      device.cli.currentDhcpPool = pool.name;
      return "";
    }
  }

  if (matches(lower[1], "access-list", 3)) {
    if (!matches(lower[2], "extended", 3) || !tokens[3]) return "% Incomplete command. Usage: ip access-list extended <name>";
    ensureAcl(device, tokens[3]);
    device.cli.mode = "acl";
    device.cli.currentAcl = tokens[3];
    return "";
  }

  if (matches(lower[1], "nat", 2)) {
    if (!(matches(lower[2], "inside", 2) && matches(lower[3], "source", 2) && matches(lower[4], "list", 2))) {
      return "% Incomplete command. Usage: ip nat inside source list <ACL> interface <IF> overload";
    }
    const aclName = tokens[5];
    const ifaceName = tokens[7];
    if (!aclName || !matches(lower[6], "interface", 3) || !ifaceName || !matches(lower[8], "overload", 2)) {
      return "% Incomplete command. Usage: ip nat inside source list <ACL> interface <IF> overload";
    }
    if (!findAcl(device, aclName)) return `% ACL '${aclName}' not found.`;
    const iface = findInterface(device, ifaceName);
    if (!iface) return `% Unknown interface '${ifaceName}'.`;
    if (iface.natRole !== "outside") return "% NAT outside interface missing. Configure 'ip nat outside' first.";
    if (!device.interfaces.some((item) => item.natRole === "inside")) return "% NAT inside interface missing. Configure 'ip nat inside' first.";
    if (!device.nat.overloadRules.some((rule) => rule.aclName.toLowerCase() === aclName.toLowerCase() && normalizeInterfaceName(rule.interface) === normalizeInterfaceName(iface.name))) {
      device.nat.overloadRules.push({ aclName, interface: iface.name, overload: true });
    }
    return "";
  }

  return `% Unknown IP command '${tokens.slice(1).join(" ")}'.`;
}

function interfaceCommand(device: Device, tokens: string[], lower: string[]): string {
  const iface = device.cli.currentInterface ? findInterface(device, device.cli.currentInterface) : null;
  if (!iface) return "% Interface context is invalid.";
  const verb = lower[0];
  if (matches(verb, "interface", 3) || verb === "int") {
    if (!tokens[1]) return "% Incomplete command. Usage: interface <name>";
    const nextIface = findInterface(device, tokens[1]);
    if (!nextIface) return `% Unknown interface '${tokens[1]}'.`;
    device.cli.currentInterface = nextIface.name;
    return "";
  }
  if (matches(verb, "description", 4)) {
    iface.description = tokens.slice(1).join(" ");
    return "";
  }
  if (verb === "shutdown") {
    iface.up = false;
    return "";
  }
  if (verb === "no" && matches(lower[1], "shutdown", 2)) {
    iface.up = true;
    return "";
  }
  if (matches(verb, "service-policy", 7)) {
    if (!["input", "output"].includes(lower[1]) || !tokens[2]) return "% Incomplete command. Usage: service-policy input|output <policy>";
    const policyName = Object.keys(device.qos.policyMaps).find((name) => name.toLowerCase() === tokens[2].toLowerCase());
    if (!policyName) return `% QoS policy-map '${tokens[2]}' not found.`;
    if (lower[1] === "input") iface.servicePolicyIn = policyName;
    else iface.servicePolicyOut = policyName;
    return "";
  }
  if (verb !== "ip") return unknownCommand(tokens.join(" "), baseSuggestions(device).filter((candidate) => candidate.toLowerCase().startsWith(verb || "")));
  if (matches(lower[1], "address", 2)) {
    if (!isValidIp(tokens[2])) return "% Invalid IP address.";
    if (!isValidMask(tokens[3])) return "% Invalid subnet mask.";
    iface.ip = tokens[2];
    iface.mask = tokens[3];
    return "";
  }
  if (matches(lower[1], "helper-address", 2)) {
    if (!isValidIp(tokens[2])) return "% Invalid IP address.";
    iface.helperAddress = tokens[2];
    return "";
  }
  if (matches(lower[1], "access-group", 2)) {
    if (!tokens[2] || !["in", "out"].includes(lower[3])) return "% Incomplete command. Usage: ip access-group <name> in|out";
    if (!findAcl(device, tokens[2])) return `% ACL '${tokens[2]}' not found.`;
    if (lower[3] === "in") iface.aclIn = tokens[2];
    else iface.aclOut = tokens[2];
    return "";
  }
  if (matches(lower[1], "nat", 2)) {
    if (matches(lower[2], "inside", 2)) iface.natRole = "inside";
    else if (matches(lower[2], "outside", 2)) iface.natRole = "outside";
    else return "% NAT role must be inside or outside.";
    return "";
  }
  return `% Unknown command '${tokens.join(" ")}'.`;
}

function dhcpCommand(device: Device, tokens: string[], lower: string[]): string {
  const pool = device.dhcpPools.find((item) => item.name === device.cli.currentDhcpPool);
  if (!pool) return "% DHCP pool context is invalid.";
  if (matches(lower[0], "network", 3)) {
    if (!isValidIp(tokens[1]) || !isValidMask(tokens[2])) return "% Invalid network or mask.";
    pool.network = networkAddress(tokens[1], tokens[2]);
    pool.mask = tokens[2];
    return "";
  }
  if (matches(lower[0], "default-router", 8)) {
    if (!isValidIp(tokens[1])) return "% Invalid IP address.";
    pool.defaultRouter = tokens[1];
    return "";
  }
  if (matches(lower[0], "dns-server", 3)) {
    if (!isValidIp(tokens[1])) return "% Invalid IP address.";
    pool.dnsServer = tokens[1];
    return "";
  }
  return unknownCommand(tokens.join(" "), baseSuggestions(device).filter((candidate) => candidate.toLowerCase().startsWith(lower[0] || "")));
}

function parseEndpoint(tokens: string[], start: number): { endpoint?: AclEndpoint; next: number; error?: string } {
  if (tokens[start]?.toLowerCase() === "any") return { endpoint: { value: "any", wildcard: "255.255.255.255" }, next: start + 1 };
  if (!isValidIp(tokens[start]) || !isValidIp(tokens[start + 1])) return { next: start, error: "% Invalid IP address or wildcard mask." };
  return { endpoint: { value: tokens[start], wildcard: tokens[start + 1] }, next: start + 2 };
}

function aclCommand(device: Device, tokens: string[], lower: string[]): string {
  const acl = device.cli.currentAcl ? findAcl(device, device.cli.currentAcl)?.acl : null;
  if (!acl) return "% ACL context is invalid.";
  if (lower[0] === "no") {
    const sequence = Number(tokens[1]);
    if (!Number.isInteger(sequence) || sequence % 10 !== 0) return "% Use ACL sequence number, such as 'no 10'.";
    const index = sequence / 10 - 1;
    if (!acl.entries[index]) return `% ACL sequence ${sequence} not found.`;
    acl.entries.splice(index, 1);
    return "";
  }
  if (!(lower[0] === "permit" || lower[0] === "deny")) return unknownCommand(tokens.join(" "), baseSuggestions(device).filter((candidate) => candidate.toLowerCase().startsWith(lower[0] || "")));
  if (!["ip", "icmp", "tcp", "udp"].includes(lower[1])) return "% Protocol must be ip, icmp, tcp, or udp.";
  const source = parseEndpoint(tokens, 2);
  if (source.error || !source.endpoint) return source.error || "% Incomplete command.";
  const destination = parseEndpoint(tokens, source.next);
  if (destination.error || !destination.endpoint) return destination.error || "% Incomplete command.";
  let port: number | null = null;
  if (lower[1] === "tcp" || lower[1] === "udp") {
    if (lower[destination.next] !== "eq" || !tokens[destination.next + 1]) return "% TCP/UDP ACL entries require 'eq <port>'.";
    port = Number(tokens[destination.next + 1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return "% Invalid TCP/UDP port.";
  }
  acl.entries.push({ action: lower[0] as "permit" | "deny", protocol: lower[1] as Protocol, source: source.endpoint, destination: destination.endpoint, port });
  return "";
}

function routingCommand(device: Device, tokens: string[], lower: string[]): string {
  const process = device.cli.currentRouting ? findRoutingProcess(device, device.cli.currentRouting) : null;
  if (!process) return "% Routing process context is invalid.";
  if (matches(lower[0], "network", 3)) {
    if (!isValidIp(tokens[1])) return "% Incomplete command. Usage: network <network> [wildcard]";
    if (tokens[2] && !isValidIp(tokens[2])) return "% Invalid wildcard mask.";
    const network = tokens[1];
    const wildcard = tokens[2] || "";
    const existing = process.networks.find((item) => item.network === network && item.wildcard === wildcard);
    if (!existing) process.networks.push({ network, wildcard });
    return "";
  }
  if (lower[0] === "version") {
    if (process.protocol !== "rip") return "% Version is supported in RIP mode only.";
    const version = Number(tokens[1]);
    if (![1, 2].includes(version)) return "% RIP version must be 1 or 2.";
    process.version = version;
    return "";
  }
  if (lower[0] === "no") {
    if (matches(lower[1], "auto-summary", 1)) {
      process.noAutoSummary = true;
      return "";
    }
    if (matches(lower[1], "network", 3)) {
      if (!isValidIp(tokens[2])) return "% Incomplete command. Usage: no network <network> [wildcard]";
      const wildcard = tokens[3] || "";
      process.networks = process.networks.filter((item) => !(item.network === tokens[2] && item.wildcard === wildcard));
      return "";
    }
    if (matches(lower[1], "passive-interface", 3)) {
      const iface = tokens[2] ? findInterface(device, tokens[2]) : null;
      if (!iface) return "% Incomplete command. Usage: no passive-interface <if>";
      process.passiveInterfaces = (process.passiveInterfaces || []).filter((name) => normalizeInterfaceName(name) !== normalizeInterfaceName(iface.name));
      return "";
    }
  }
  if (matches(lower[0], "passive-interface", 3)) {
    const iface = tokens[1] ? findInterface(device, tokens[1]) : null;
    if (!iface) return "% Incomplete command. Usage: passive-interface <if>";
    if (!process.passiveInterfaces?.some((name) => normalizeInterfaceName(name) === normalizeInterfaceName(iface.name))) {
      process.passiveInterfaces = [...(process.passiveInterfaces || []), iface.name];
    }
    return "";
  }
  return unknownCommand(tokens.join(" "), baseSuggestions(device).filter((candidate) => candidate.toLowerCase().startsWith(lower[0] || "")));
}

function classMapCommand(device: Device, tokens: string[], lower: string[]): string {
  const classMap = device.cli.currentClassMap ? ensureQosClass(device, device.cli.currentClassMap) : null;
  if (!classMap) return "% Class-map context is invalid.";
  if (matches(lower[0], "match", 3)) {
    let match = "";
    if (matches(lower[1], "protocol", 3) && tokens[2]) match = `protocol ${tokens[2]}`;
    else if (matches(lower[1], "access-group", 3) && lower[2] === "name" && tokens[3]) match = `access-group name ${tokens[3]}`;
    else return "% Incomplete command. Usage: match protocol <name> | match access-group name <acl>";
    if (!classMap.matches.some((item) => item.toLowerCase() === match.toLowerCase())) classMap.matches.push(match);
    return "";
  }
  if (lower[0] === "no" && matches(lower[1], "match", 3)) {
    const target = tokens.slice(2).join(" ").toLowerCase();
    classMap.matches = target ? classMap.matches.filter((item) => item.toLowerCase() !== target) : [];
    return "";
  }
  return unknownCommand(tokens.join(" "), baseSuggestions(device).filter((candidate) => candidate.toLowerCase().startsWith(lower[0] || "")));
}

function policyMapCommand(device: Device, tokens: string[], lower: string[]): string {
  if (!device.cli.currentPolicyMap) return "% Policy-map context is invalid.";
  if (matches(lower[0], "class", 3)) {
    if (!tokens[1]) return "% Incomplete command. Usage: class <name>";
    ensurePolicyClass(device, device.cli.currentPolicyMap, tokens[1]);
    device.cli.currentPolicyClass = tokens[1];
    return "";
  }
  if (lower[0] === "no" && matches(lower[1], "class", 3)) {
    const policy = ensureQosPolicy(device, device.cli.currentPolicyMap);
    if (!tokens[2]) return "% Incomplete command. Usage: no class <name>";
    policy.classes = policy.classes.filter((item) => item.className.toLowerCase() !== tokens[2].toLowerCase());
    if (device.cli.currentPolicyClass?.toLowerCase() === tokens[2].toLowerCase()) device.cli.currentPolicyClass = null;
    return "";
  }
  const policyClass = ensurePolicyClass(device, device.cli.currentPolicyMap, device.cli.currentPolicyClass);
  if (!policyClass) return "% Select a policy class first with: class <name>";
  if (matches(lower[0], "priority", 3) && matches(lower[1], "percent", 3)) {
    const value = percentValue(tokens[2]);
    if (value === null) return "% Priority percent must be 1-100.";
    policyClass.priorityPercent = value;
    return "";
  }
  if (matches(lower[0], "bandwidth", 3) && matches(lower[1], "percent", 3)) {
    const value = percentValue(tokens[2]);
    if (value === null) return "% Bandwidth percent must be 1-100.";
    policyClass.bandwidthPercent = value;
    return "";
  }
  if (matches(lower[0], "set", 2) && lower[1] === "dscp") {
    if (!tokens[2]) return "% Incomplete command. Usage: set dscp <value>";
    policyClass.dscp = tokens[2];
    return "";
  }
  return unknownCommand(tokens.join(" "), baseSuggestions(device).filter((candidate) => candidate.toLowerCase().startsWith(lower[0] || "")));
}

function percentValue(raw: string | undefined): number | null {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : null;
}

function showCommand(simulator: Simulator, device: Device, sub: string[]): string {
  if (!sub.length) return "% Incomplete command.";
  if (matches(sub[0], "running-config", 3) || matches(sub[0], "run", 3)) {
    if (matches(sub[1], "interface", 3) || matches(sub[1], "int", 3)) return runningConfigInterface(device, sub[2] || "");
    return runningConfig(device);
  }
  if ((matches(sub[0], "interface", 3) || sub[0] === "interfaces") && matches(sub[1], "description", 4)) return interfaceDescriptions(device);
  if (sub[0] === "ip") {
    if ((matches(sub[1], "interface", 3) || matches(sub[1], "int", 3)) && matches(sub[2], "brief", 2)) {
      return ["Interface              IP-Address      Status", ...device.interfaces.map((iface) => `${iface.name.padEnd(22)}${(iface.ip || "unassigned").padEnd(16)}${iface.up ? "up" : "down"}`)].join("\n");
    }
    if (matches(sub[1], "route", 2)) return simulator.routeTableText(device);
    if (matches(sub[1], "protocols", 4)) return ipProtocols(device);
    if (matches(sub[1], "dhcp", 2) && matches(sub[2], "binding", 2)) {
      if (!device.dhcpBindings.length) return "No DHCP bindings.";
      return ["IP address        Client         Pool", ...device.dhcpBindings.map((binding) => `${binding.ip.padEnd(17)}${binding.client.padEnd(15)}${binding.pool}`)].join("\n");
    }
    if (matches(sub[1], "nat", 2) && matches(sub[2], "translations", 2)) {
      if (!device.nat.translations.length) return "No NAT translations.";
      return ["Pro Inside global       Inside local        Outside global", ...device.nat.translations.map((entry) => `${entry.protocol.padEnd(4)}${entry.insideGlobal.padEnd(20)}${entry.insideLocal.padEnd(20)}${entry.outsideGlobal}`)].join("\n");
    }
  }
  if (matches(sub[0], "class-map", 5)) return classMaps(device);
  if (matches(sub[0], "policy-map", 5)) return policyMaps(device);
  if (sub[0] === "qos" || (sub[0] === "mls" && sub[1] === "qos")) return qosStatus(device);
  if (matches(sub[0], "access-lists", 7) || matches(sub[0], "access-list", 7)) return accessLists(device);
  return `% Unknown show target '${sub.join(" ")}'.`;
}

function normalizeServiceName(raw: string | undefined): keyof Device["services"] | null {
  if (raw === "www" || raw === "web") return "http";
  if (raw === "http" || raw === "dns" || raw === "dhcp" || raw === "mail") return raw;
  return null;
}

function endpointServices(device: Device): string {
  const lines = ["Service   State"];
  (Object.keys(device.services) as Array<keyof Device["services"]>).forEach((name) => {
    lines.push(`${name.toUpperCase().padEnd(9)}${device.services[name] ? "enabled" : "disabled"}`);
  });
  if (device.dhcpPools.length) {
    lines.push("", "DHCP pools:");
    device.dhcpPools.forEach((pool) => lines.push(` ${pool.name}: ${pool.network} ${pool.mask}, GW ${pool.defaultRouter}, DNS ${pool.dnsServer}${pool.start ? `, ${pool.start}-${pool.end || "auto"}` : ""}`));
  }
  if (Object.keys(device.dnsRecords).length) {
    lines.push("", "DNS records:");
    Object.entries(device.dnsRecords).forEach(([name, ip]) => lines.push(` ${name} -> ${ip}`));
  }
  if (device.httpContent) {
    lines.push("", "WWW response:");
    lines.push(` ${device.httpContent}`);
  }
  if (Object.keys(device.mailboxes).length) {
    lines.push("", "MAIL boxes:");
    Object.entries(device.mailboxes).forEach(([name, messages]) => lines.push(` ${name}: ${messages.length} message(s)`));
  }
  return lines.join("\n");
}

function endpointMail(device: Device, user?: string): string {
  if (!device.services.mail && !Object.keys(device.mailboxes).length) return "MAIL service disabled and no messages queued.";
  const boxes = user ? { [user]: device.mailboxes[user] || [] } : device.mailboxes;
  const names = Object.keys(boxes);
  if (!names.length) return "No mailboxes.";
  return names.flatMap((name) => {
    const messages = boxes[name] || [];
    if (!messages.length) return [`Mailbox ${name}: empty`];
    return [
      `Mailbox ${name}: ${messages.length} message(s)`,
      ...messages.map((message, index) => ` ${index + 1}. from ${message.from} at ${new Date(message.receivedAt).toLocaleString()}: ${message.body}`),
    ];
  }).join("\n");
}

function unknownCommand(command: string, suggestions: string[]): string {
  const unique = [...new Set(suggestions)].slice(0, 5);
  if (!unique.length) return `% Unknown command '${command}'. Type '?' for supported commands.`;
  return [`% Unknown command '${command}'.`, "Nearby supported commands:", ...unique.map((item) => `  ${item}`)].join("\n");
}

function runningConfigInterface(device: Device, ifaceName: string): string {
  if (!ifaceName) return "% Incomplete command. Usage: show running-config interface <if>";
  const iface = findInterface(device, ifaceName);
  if (!iface) return `% Unknown interface '${ifaceName}'.`;
  return interfaceConfigLines(iface).join("\n");
}

function interfaceConfigLines(iface: Device["interfaces"][number]): string[] {
  const lines = [`interface ${iface.name}`];
  if (iface.description) lines.push(` description ${iface.description}`);
  if (iface.ip && iface.mask) lines.push(` ip address ${iface.ip} ${iface.mask}`);
  if (iface.helperAddress) lines.push(` ip helper-address ${iface.helperAddress}`);
  if (iface.aclIn) lines.push(` ip access-group ${iface.aclIn} in`);
  if (iface.aclOut) lines.push(` ip access-group ${iface.aclOut} out`);
  if (iface.natRole === "inside") lines.push(" ip nat inside");
  if (iface.natRole === "outside") lines.push(" ip nat outside");
  if (iface.servicePolicyIn) lines.push(` service-policy input ${iface.servicePolicyIn}`);
  if (iface.servicePolicyOut) lines.push(` service-policy output ${iface.servicePolicyOut}`);
  lines.push(iface.up ? " no shutdown" : " shutdown", "!");
  return lines;
}

export function runningConfig(device: Device): string {
  const lines = ["version 15.0", `hostname ${device.name}`, "!"];
  device.interfaces.forEach((iface) => {
    lines.push(...interfaceConfigLines(iface));
  });
  device.dhcpExcluded.forEach((range) => lines.push(range.start === range.end ? `ip dhcp excluded-address ${range.start}` : `ip dhcp excluded-address ${range.start} ${range.end}`));
  device.dhcpPools.forEach((pool) => lines.push(`ip dhcp pool ${pool.name}`, ` network ${pool.network} ${pool.mask}`, ` default-router ${pool.defaultRouter}`, ` dns-server ${pool.dnsServer}`, "!"));
  device.staticRoutes.forEach((route) => lines.push(staticRouteLine(route)));
  Object.values(device.acls).forEach((acl) => {
    lines.push(`ip access-list extended ${acl.name}`);
    acl.entries.forEach((entry) => {
      const src = entry.source.value === "any" ? "any" : `${entry.source.value} ${entry.source.wildcard}`;
      const dst = entry.destination.value === "any" ? "any" : `${entry.destination.value} ${entry.destination.wildcard}`;
      lines.push(` ${entry.action} ${entry.protocol} ${src} ${dst}${entry.port ? ` eq ${entry.port}` : ""}`);
    });
    lines.push("!");
  });
  device.nat.overloadRules.forEach((rule) => lines.push(`ip nat inside source list ${rule.aclName} interface ${rule.interface} overload`));
  lines.push(...dynamicRoutingConfigLines(device));
  lines.push(...qosConfigLines(device));
  return lines.join("\n");
}

function interfaceDescriptions(device: Device): string {
  if (!device.interfaces.length) return "No interfaces.";
  return [
    "Interface              Status  Description",
    ...device.interfaces.map((iface) => `${iface.name.padEnd(22)}${(iface.up ? "up" : "down").padEnd(8)}${iface.description || "--"}`),
  ].join("\n");
}

function accessLists(device: Device): string {
  const names = Object.keys(device.acls);
  if (!names.length) return "No access lists configured.";
  return names.flatMap((name) => {
    const acl = device.acls[name];
    return [
      `Extended IP access list ${acl.name}`,
      ...acl.entries.map((entry, index) => {
        const src = entry.source.value === "any" ? "any" : `${entry.source.value} ${entry.source.wildcard}`;
        const dst = entry.destination.value === "any" ? "any" : `${entry.destination.value} ${entry.destination.wildcard}`;
        return ` ${String((index + 1) * 10).padEnd(4)}${entry.action} ${entry.protocol} ${src} ${dst}${entry.port ? ` eq ${entry.port}` : ""}`;
      }),
    ];
  }).join("\n");
}

function routingNetworkText(item: DynamicRoutingProcess["networks"][number]): string {
  return item.wildcard ? `${item.network} ${item.wildcard}` : item.network;
}

function dynamicRoutingConfigLines(device: Device): string[] {
  return device.dynamicRouting.flatMap((process) => {
    const lines = [process.protocol === "rip" ? "router rip" : `router eigrp ${process.processId}`];
    if (process.protocol === "rip" && process.version) lines.push(` version ${process.version}`);
    if (process.noAutoSummary) lines.push(" no auto-summary");
    process.networks.forEach((network) => lines.push(` network ${routingNetworkText(network)}`));
    (process.passiveInterfaces || []).forEach((iface) => lines.push(` passive-interface ${iface}`));
    lines.push("!");
    return lines;
  });
}

function ipProtocols(device: Device): string {
  if (!device.dynamicRouting.length) return "No routing protocols configured.";
  return device.dynamicRouting.flatMap((process) => {
    const lines = [
      `Routing Protocol is "${process.protocol === "rip" ? "rip" : `eigrp ${process.processId}`}"`,
      `  Sending updates from ${process.networks.length} network statement(s).`,
    ];
    if (process.protocol === "rip") lines.push(`  RIP version ${process.version || 2}`);
    if (process.noAutoSummary) lines.push("  Automatic network summarization is not in effect.");
    if (process.passiveInterfaces?.length) lines.push(`  Passive interfaces: ${process.passiveInterfaces.join(", ")}`);
    lines.push("  Routing for Networks:");
    if (process.networks.length) process.networks.forEach((network) => lines.push(`    ${routingNetworkText(network)}`));
    else lines.push("    none");
    return lines;
  }).join("\n");
}

function classMaps(device: Device): string {
  const maps = Object.values(device.qos.classMaps);
  if (!maps.length) return "No class-maps configured.";
  return maps.flatMap((classMap) => [
    `Class Map match-${classMap.matchType} ${classMap.name}`,
    ...(classMap.matches.length ? classMap.matches.map((item) => `  Match ${item}`) : ["  No match criteria"]),
  ]).join("\n");
}

function policyMaps(device: Device): string {
  const maps = Object.values(device.qos.policyMaps);
  if (!maps.length) return "No policy-maps configured.";
  return maps.flatMap((policy) => [
    `Policy Map ${policy.name}`,
    ...(policy.classes.length ? policy.classes.flatMap((policyClass) => [
      `  Class ${policyClass.className}`,
      ...(policyClass.priorityPercent ? [`    priority percent ${policyClass.priorityPercent}`] : []),
      ...(policyClass.bandwidthPercent ? [`    bandwidth percent ${policyClass.bandwidthPercent}`] : []),
      ...(policyClass.dscp ? [`    set dscp ${policyClass.dscp}`] : []),
    ]) : ["  No classes"]),
  ]).join("\n");
}

function qosStatus(device: Device): string {
  return [
    `QoS: ${device.qos.enabled ? "enabled" : "disabled"}`,
    `Trust: ${device.qos.trust || "--"}`,
    `Class-maps: ${Object.keys(device.qos.classMaps).length}`,
    `Policy-maps: ${Object.keys(device.qos.policyMaps).length}`,
  ].join("\n");
}

function qosConfigLines(device: Device): string[] {
  const lines: string[] = [];
  if (device.qos.enabled) lines.push("mls qos");
  if (device.qos.trust) lines.push(`qos trust ${device.qos.trust}`);
  Object.values(device.qos.classMaps).forEach((classMap) => {
    lines.push(`class-map match-${classMap.matchType} ${classMap.name}`);
    classMap.matches.forEach((match) => lines.push(` match ${match}`));
    lines.push("!");
  });
  Object.values(device.qos.policyMaps).forEach((policy) => {
    lines.push(`policy-map ${policy.name}`);
    policy.classes.forEach((policyClass) => {
      lines.push(` class ${policyClass.className}`);
      if (policyClass.priorityPercent) lines.push(`  priority percent ${policyClass.priorityPercent}`);
      if (policyClass.bandwidthPercent) lines.push(`  bandwidth percent ${policyClass.bandwidthPercent}`);
      if (policyClass.dscp) lines.push(`  set dscp ${policyClass.dscp}`);
    });
    lines.push("!");
  });
  return lines;
}

export function selectedInterfacesText(device: Device | null): string {
  return device ? interfaceText(device) : "";
}
