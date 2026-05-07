import type { AclEntry, Device, LabState, ValidationCheck, ValidationResult } from "../types";
import { getInterface, ipInSubnet, ipToInt, isValidIp, networkAddress, rangeContains } from "./ip";
import { Simulator } from "./simulator";

function device(lab: LabState, id: string): Device | null {
  return lab.devices[id] || null;
}

function ifaceMatches(lab: LabState, deviceId: string, name: string, ip: string, mask: string, requireUp = true): boolean {
  const iface = getInterface(device(lab, deviceId), name);
  return Boolean(iface && iface.ip === ip && iface.mask === mask && (!requireUp || iface.up));
}

function endpointMatches(lab: LabState, deviceId: string, ip: string, mask: string, gateway: string, dns?: string): boolean {
  const endpoint = device(lab, deviceId);
  const iface = endpoint?.interfaces[0];
  return Boolean(iface && iface.up && iface.ip === ip && iface.mask === mask && endpoint?.gateway === gateway && (dns === undefined || endpoint.dns === dns));
}

function routeExists(lab: LabState, deviceId: string, network: string, mask: string, nextHop: string): boolean {
  const router = device(lab, deviceId);
  const normalized = networkAddress(network, mask);
  return Boolean(router?.staticRoutes.some((route) => route.network === normalized && route.mask === mask && route.nextHop === nextHop));
}

function dhcpPoolMatches(lab: LabState, deviceId: string, network: string, mask: string, gateway: string, dns: string): boolean {
  const router = device(lab, deviceId);
  return Boolean(router?.dhcpPools.some((pool) => pool.network === networkAddress(network, mask) && pool.mask === mask && pool.defaultRouter === gateway && pool.dnsServer === dns));
}

function excludedCovers(lab: LabState, deviceId: string, start: string, end: string): boolean {
  const router = device(lab, deviceId);
  return Boolean(router?.dhcpExcluded.some((range) => rangeContains(range, start, end)));
}

function leaseInRange(lab: LabState, deviceId: string, network: string, mask: string, start: string, end: string, gateway: string, dns: string): boolean {
  const endpoint = device(lab, deviceId);
  const iface = endpoint?.interfaces[0];
  if (!endpoint || !iface || !isValidIp(iface.ip)) return false;
  const value = ipToInt(iface.ip);
  return iface.up
    && iface.mask === mask
    && ipInSubnet(iface.ip, network, mask)
    && value >= ipToInt(start)
    && value <= ipToInt(end)
    && endpoint.gateway === gateway
    && endpoint.dns === dns;
}

function aclEntries(lab: LabState, deviceId: string, aclName: string): AclEntry[] {
  const router = device(lab, deviceId);
  const key = Object.keys(router?.acls || {}).find((name) => name.toLowerCase() === aclName.toLowerCase());
  return key && router ? router.acls[key].entries : [];
}

function ruleMatches(entry: AclEntry, criteria: Partial<{
  action: string;
  protocol: string;
  srcValue: string;
  srcWildcard: string;
  dstValue: string;
  dstWildcard: string;
  port: number | null;
}>): boolean {
  return (!criteria.action || entry.action === criteria.action)
    && (!criteria.protocol || entry.protocol === criteria.protocol)
    && (!criteria.srcValue || entry.source.value === criteria.srcValue)
    && (!criteria.srcWildcard || entry.source.wildcard === criteria.srcWildcard)
    && (!criteria.dstValue || entry.destination.value === criteria.dstValue)
    && (!criteria.dstWildcard || entry.destination.wildcard === criteria.dstWildcard)
    && (criteria.port === undefined || Number(entry.port || 0) === Number(criteria.port || 0));
}

function hasRule(lab: LabState, deviceId: string, aclName: string, criteria: Parameters<typeof ruleMatches>[1]): boolean {
  return aclEntries(lab, deviceId, aclName).some((entry) => ruleMatches(entry, criteria));
}

function rulesInOrder(entries: AclEntry[], rules: Array<Parameters<typeof ruleMatches>[1]>): boolean {
  let cursor = 0;
  for (const rule of rules) {
    const index = entries.findIndex((entry, entryIndex) => entryIndex >= cursor && ruleMatches(entry, rule));
    if (index === -1) return false;
    cursor = index + 1;
  }
  return true;
}

function wildcardMatches(ip: string, value: string, wildcard: string): boolean {
  if (value === "any") return true;
  if (!isValidIp(ip) || !isValidIp(value) || !isValidIp(wildcard)) return false;
  const mask = (~ipToInt(wildcard)) >>> 0;
  return (ipToInt(ip) & mask) === (ipToInt(value) & mask);
}

function firstAclAction(lab: LabState, deviceId: string, aclName: string, packet: { protocol: "icmp" | "tcp" | "udp"; srcIp: string; dstIp: string; port?: number | null }): string {
  for (const entry of aclEntries(lab, deviceId, aclName)) {
    if (!(entry.protocol === "ip" || entry.protocol === packet.protocol)) continue;
    if (!wildcardMatches(packet.srcIp, entry.source.value, entry.source.wildcard)) continue;
    if (!wildcardMatches(packet.dstIp, entry.destination.value, entry.destination.wildcard)) continue;
    if ((entry.protocol === "tcp" || entry.protocol === "udp") && entry.port && Number(entry.port) !== Number(packet.port || 0)) continue;
    return entry.action;
  }
  return "implicit-deny";
}

function findAclWithRules(lab: LabState, deviceId: string, rules: Array<Parameters<typeof ruleMatches>[1]>): string {
  const router = device(lab, deviceId);
  return Object.keys(router?.acls || {}).find((aclName) => rulesInOrder(aclEntries(lab, deviceId, aclName), rules)) || "";
}

function aclApplied(lab: LabState, deviceId: string, aclName: string): boolean {
  const router = device(lab, deviceId);
  return Boolean(router?.interfaces.some((iface) => iface.aclIn === aclName || iface.aclOut === aclName));
}

function natOverloadConfigured(lab: LabState): boolean {
  const router = device(lab, "r1");
  return Boolean(router?.nat.overloadRules.some((rule) =>
    rule.interface === "g0/1"
    && hasRule(lab, "r1", rule.aclName, { action: "permit", protocol: "ip", srcValue: "192.168.50.0", srcWildcard: "0.0.0.255", dstValue: "any" })
  ));
}

function translationExists(lab: LabState): boolean {
  return Boolean(device(lab, "r1")?.nat.translations.some((entry) =>
    entry.insideLocal === "192.168.50.10" && entry.insideGlobal === "203.0.113.2" && entry.outsideGlobal === "198.51.100.10"
  ));
}

function connectivityOk(lab: LabState, sourceId: string, targetIp: string, protocol: "icmp" | "tcp" | "udp" = "icmp", port: number | null = null): boolean {
  const result = new Simulator(lab).analyzeConnectivity(sourceId, targetIp, protocol, port);
  return Boolean(result.ok && result.targetFound);
}

function dnsOk(lab: LabState, sourceId: string, domain: string, ip: string): boolean {
  const source = device(lab, sourceId);
  const result = source ? new Simulator(lab).resolveDomain(source, domain) : null;
  return Boolean(result?.ok && result.ip === ip);
}

function curlOk(lab: LabState, sourceId: string, target: string): boolean {
  return new Simulator(lab).curl(sourceId, target).startsWith("HTTP/1.1 200 OK");
}

function curlDeniedByAcl(lab: LabState, sourceId: string, target: string): boolean {
  const output = new Simulator(lab).curl(sourceId, target);
  return !output.startsWith("HTTP/1.1 200 OK") && output.includes("ACL deny");
}

function recipeHasDuplicateIps(lab: LabState): boolean {
  const seen = new Set<string>();
  for (const item of Object.values(lab.devices).flatMap((candidate) => candidate.interfaces.map((iface) => iface.ip).filter(Boolean))) {
    if (seen.has(item)) return true;
    seen.add(item);
  }
  return false;
}

function endpointGatewayLocal(lab: LabState, deviceId: string): boolean {
  const endpoint = device(lab, deviceId);
  const iface = endpoint?.interfaces[0];
  return Boolean(endpoint && iface?.ip && iface.mask && endpoint.gateway && ipInSubnet(endpoint.gateway, iface.ip, iface.mask));
}

export function validateScenario(lab: LabState): ValidationResult {
  const checks: ValidationCheck[] = [];
  const scenarioId = lab.currentScenarioId;

  if (scenarioId === "blank") {
    checks.push({ label: "Blank workspace is ready for custom topology building", pass: true });
  } else if (scenarioId === "s1") {
    checks.push({ label: "R1 G0/0 is 192.168.10.1/24 and up", pass: ifaceMatches(lab, "r1", "g0/0", "192.168.10.1", "255.255.255.0") });
    checks.push({ label: "PC1 is 192.168.10.10/24 with gateway 192.168.10.1", pass: endpointMatches(lab, "pc1", "192.168.10.10", "255.255.255.0", "192.168.10.1") });
    checks.push({ label: "PC1 can ping the gateway", pass: connectivityOk(lab, "pc1", "192.168.10.1") });
  } else if (scenarioId === "s2") {
    checks.push({ label: "R1 G0/0 is 192.168.20.1/24 and up", pass: ifaceMatches(lab, "r1", "g0/0", "192.168.20.1", "255.255.255.0") });
    checks.push({ label: "R1 excludes 192.168.20.1 through 192.168.20.20", pass: excludedCovers(lab, "r1", "192.168.20.1", "192.168.20.20") });
    checks.push({ label: "R1 DHCP pool has the correct network, gateway, and DNS", pass: dhcpPoolMatches(lab, "r1", "192.168.20.0", "255.255.255.0", "192.168.20.1", "8.8.8.8") });
    checks.push({ label: "PC1 has a valid DHCP lease", pass: leaseInRange(lab, "pc1", "192.168.20.0", "255.255.255.0", "192.168.20.21", "192.168.20.254", "192.168.20.1", "8.8.8.8") });
    checks.push({ label: "PC2 has a valid DHCP lease", pass: leaseInRange(lab, "pc2", "192.168.20.0", "255.255.255.0", "192.168.20.21", "192.168.20.254", "192.168.20.1", "8.8.8.8") });
    checks.push({ label: "Both PCs can ping the gateway", pass: connectivityOk(lab, "pc1", "192.168.20.1") && connectivityOk(lab, "pc2", "192.168.20.1") });
  } else if (scenarioId === "s3") {
    checks.push({ label: "PC1 has address, gateway, and DNS", pass: endpointMatches(lab, "pc1", "192.168.30.10", "255.255.255.0", "192.168.30.1", "10.10.10.10") });
    checks.push({ label: "R1 connects PC and server networks", pass: ifaceMatches(lab, "r1", "g0/0", "192.168.30.1", "255.255.255.0") && ifaceMatches(lab, "r1", "g0/1", "10.10.10.1", "255.255.255.0") });
    checks.push({ label: "PC1 can reach the DNS/web server", pass: connectivityOk(lab, "pc1", "10.10.10.10") });
    checks.push({ label: "nslookup intranet.local resolves", pass: dnsOk(lab, "pc1", "intranet.local", "10.10.10.10") });
    checks.push({ label: "curl intranet.local succeeds", pass: curlOk(lab, "pc1", "intranet.local") });
  } else if (scenarioId === "s4") {
    checks.push({ label: "PC default gateways are correct", pass: endpointMatches(lab, "pc1", "192.168.40.10", "255.255.255.0", "192.168.40.1") && endpointMatches(lab, "pc2", "192.168.41.10", "255.255.255.0", "192.168.41.1") });
    checks.push({ label: "R1 interfaces are configured", pass: ifaceMatches(lab, "r1", "g0/0", "192.168.40.1", "255.255.255.0") && ifaceMatches(lab, "r1", "g0/1", "10.0.12.1", "255.255.255.252") });
    checks.push({ label: "R2 interfaces are configured", pass: ifaceMatches(lab, "r2", "g0/0", "10.0.12.2", "255.255.255.252") && ifaceMatches(lab, "r2", "g0/1", "192.168.41.1", "255.255.255.0") });
    checks.push({ label: "Static routes exist both directions", pass: routeExists(lab, "r1", "192.168.41.0", "255.255.255.0", "10.0.12.2") && routeExists(lab, "r2", "192.168.40.0", "255.255.255.0", "10.0.12.1") });
    checks.push({ label: "PC1 can ping PC2", pass: connectivityOk(lab, "pc1", "192.168.41.10") });
  } else if (scenarioId === "s5") {
    const http = curlOk(lab, "pc1", "198.51.100.10");
    checks.push({ label: "PC and router addresses are correct", pass: endpointMatches(lab, "pc1", "192.168.50.10", "255.255.255.0", "192.168.50.1") && ifaceMatches(lab, "r1", "g0/0", "192.168.50.1", "255.255.255.0") && ifaceMatches(lab, "r1", "g0/1", "203.0.113.2", "255.255.255.252") });
    checks.push({ label: "NAT inside/outside roles are set", pass: getInterface(device(lab, "r1"), "g0/0")?.natRole === "inside" && getInterface(device(lab, "r1"), "g0/1")?.natRole === "outside" });
    checks.push({ label: "Default route points to ISP", pass: routeExists(lab, "r1", "0.0.0.0", "0.0.0.0", "203.0.113.1") });
    checks.push({ label: "PAT overload rule is configured", pass: natOverloadConfigured(lab) });
    checks.push({ label: "PC1 can reach PublicWeb through NAT", pass: http });
    checks.push({ label: "NAT translation table populated", pass: translationExists(lab) });
  } else if (scenarioId === "s6") {
    const acl = findAclWithRules(lab, "r1", [
      { action: "deny", protocol: "tcp", srcValue: "192.168.60.10", srcWildcard: "0.0.0.0", dstValue: "10.60.0.10", dstWildcard: "0.0.0.0", port: 80 },
      { action: "permit", protocol: "udp", srcValue: "192.168.60.10", srcWildcard: "0.0.0.0", dstValue: "10.60.0.10", dstWildcard: "0.0.0.0", port: 53 },
      { action: "permit", protocol: "tcp", srcValue: "192.168.60.20", srcWildcard: "0.0.0.0", dstValue: "10.60.0.10", dstWildcard: "0.0.0.0", port: 80 },
    ]);
    const studentHttpFirstAction = acl ? firstAclAction(lab, "r1", acl, { protocol: "tcp", srcIp: "192.168.60.10", dstIp: "10.60.0.10", port: 80 }) : "";
    checks.push({ label: "Student DNS lookup works", pass: dnsOk(lab, "student", "lab.local", "10.60.0.10") });
    checks.push({ label: "Student HTTP is blocked by ACL", pass: curlDeniedByAcl(lab, "student", "lab.local") });
    checks.push({ label: "Admin HTTP works", pass: curlOk(lab, "admin", "lab.local") });
    checks.push({ label: "ACL contains the required ordered policy", pass: Boolean(acl && studentHttpFirstAction === "deny") });
    checks.push({ label: "ACL is applied on R1", pass: Boolean(acl && aclApplied(lab, "r1", acl)) });
  } else if (scenarioId === "s7") {
    const broadDeny = hasRule(lab, "r1", "WEBGUARD", { action: "deny", protocol: "tcp", srcValue: "192.168.70.0", srcWildcard: "0.0.0.255", dstValue: "any", port: 80 });
    checks.push({ label: "R1 G0/1 transit interface is up", pass: Boolean(getInterface(device(lab, "r1"), "g0/1")?.up) });
    checks.push({ label: "OfficePC gateway is corrected", pass: endpointMatches(lab, "pc1", "192.168.70.10", "255.255.255.0", "192.168.70.1", "10.70.10.10") });
    checks.push({ label: "OFFICE DHCP pool default-router is corrected", pass: dhcpPoolMatches(lab, "r1", "192.168.70.0", "255.255.255.0", "192.168.70.1", "10.70.10.10") });
    checks.push({ label: "DhcpClient has a renewed office lease", pass: leaseInRange(lab, "pc2", "192.168.70.0", "255.255.255.0", "192.168.70.21", "192.168.70.80", "192.168.70.1", "10.70.10.10") });
    checks.push({ label: "R1 has the missing server route", pass: routeExists(lab, "r1", "10.70.10.0", "255.255.255.0", "10.0.72.2") });
    checks.push({ label: "Broad WEBGUARD HTTP deny has been removed", pass: !broadDeny });
    checks.push({ label: "OfficePC resolves and opens troubleshoot.local", pass: dnsOk(lab, "pc1", "troubleshoot.local", "10.70.10.10") && curlOk(lab, "pc1", "troubleshoot.local") });
  } else if (scenarioId === "recipe") {
    const routers = Object.values(lab.devices).filter((item) => item.type === "router");
    const endpoints = Object.values(lab.devices).filter((item) => item.type === "pc" || item.type === "server");
    checks.push({ label: "Recipe generated routers and endpoint LANs", pass: routers.length >= 2 && endpoints.length >= 1 });
    checks.push({ label: "All router interfaces are addressed and up", pass: routers.length > 0 && routers.every((router) => router.interfaces.length > 0 && router.interfaces.every((iface) => Boolean(iface.up && iface.ip && iface.mask))) });
    checks.push({ label: "No duplicate IP addresses exist", pass: !recipeHasDuplicateIps(lab) });
    checks.push({ label: "Endpoint gateways are inside their local subnets", pass: endpoints.length > 0 && endpoints.every((endpoint) => endpointGatewayLocal(lab, endpoint.id)) });
    checks.push({ label: "Each endpoint can ping its generated gateway", pass: endpoints.length > 0 && endpoints.every((endpoint) => connectivityOk(lab, endpoint.id, endpoint.gateway)) });
  }

  const passed = checks.filter((check) => check.pass).length;
  const total = checks.length;
  const result = { checks, passed, total, allPassed: passed === total };
  lab.progress[scenarioId] = {
    completed: result.allPassed,
    score: Math.round((passed / Math.max(total, 1)) * 100),
    lastValidatedAt: new Date().toISOString(),
  };
  lab.score = lab.progress[scenarioId].score;
  return result;
}
