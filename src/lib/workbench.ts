import type { Device, FlowState, LabState, Link } from "../types";
import { runningConfig } from "./cli";
import { getInterface, ipInSubnet, isValidIp, maskToPrefix } from "./ip";
import { Simulator } from "./simulator";

export type WorkbenchTool = "debug" | "scan" | "export";
export type TopologyIssueSeverity = "critical" | "warning" | "info";

export interface TopologyIssue {
  id: string;
  severity: TopologyIssueSeverity;
  title: string;
  detail: string;
  deviceId?: string;
  linkId?: string;
  command?: string;
}

export interface DiagnosticAction {
  label: string;
  command: string;
  deviceId?: string;
}

const severityRank: Record<TopologyIssueSeverity, number> = { critical: 0, warning: 1, info: 2 };

function html(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function showPrefix(device: Device): string {
  return ["config", "interface", "dhcp", "acl", "routing", "class-map", "policy-map"].includes(device.cli.mode) ? "do " : "";
}

function inspectionCommand(device: Device, kind: string): string {
  if (device.type === "pc" || device.type === "server") {
    if (kind === "dns") return device.dns ? `nslookup ${device.dns}` : "ipconfig";
    return "ipconfig";
  }
  const prefix = showPrefix(device);
  if (kind === "route") return `${prefix}show ip route`;
  if (kind === "acl") return `${prefix}show access-lists`;
  if (kind === "nat") return `${prefix}show ip nat translations`;
  if (kind === "dhcp") return `${prefix}show ip dhcp binding`;
  return `${prefix}show ip interface brief`;
}

function addIssue(issues: TopologyIssue[], issue: Omit<TopologyIssue, "id">) {
  issues.push({ ...issue, id: `${issue.severity}-${issues.length + 1}` });
}

function endpoint(device: Device): boolean {
  return device.type === "pc" || device.type === "server";
}

function linkTitle(lab: LabState, link: Link): string {
  const from = lab.devices[link.from]?.name || link.from;
  const to = lab.devices[link.to]?.name || link.to;
  return `${from}/${link.fromIf} - ${to}/${link.toIf}`;
}

export function scanTopology(lab: LabState): TopologyIssue[] {
  const issues: TopologyIssue[] = [];
  const devices = Object.values(lab.devices);
  const simulator = new Simulator(lab);
  const hasDhcp = devices.some((device) => device.services.dhcp || device.dhcpPools.length > 0);
  const hasDns = devices.some((device) => device.services.dns || Object.keys(device.dnsRecords).length > 0);

  devices.forEach((device) => {
    if (!device.interfaces.length) {
      addIssue(issues, {
        severity: "critical",
        title: `${device.name}: no interfaces`,
        detail: "Device has no interfaces, so it cannot send or receive packets.",
        deviceId: device.id,
        command: "help",
      });
      return;
    }

    const upInterfaces = device.interfaces.filter((iface) => iface.up);
    const addressedUp = device.interfaces.filter((iface) => iface.up && iface.ip && iface.mask);
    if (device.type !== "switch" && addressedUp.length < device.interfaces.length) {
      addIssue(issues, {
        severity: addressedUp.length ? "warning" : "critical",
        title: `${device.name}: interface addressing incomplete`,
        detail: `${addressedUp.length}/${device.interfaces.length} interfaces are up and addressed.`,
        deviceId: device.id,
        command: inspectionCommand(device, "interface"),
      });
    }
    if (device.type === "switch" && upInterfaces.length < device.interfaces.length) {
      addIssue(issues, {
        severity: "warning",
        title: `${device.name}: switch ports down`,
        detail: `${upInterfaces.length}/${device.interfaces.length} switch ports are up.`,
        deviceId: device.id,
        command: inspectionCommand(device, "interface"),
      });
    }

    if (endpoint(device)) {
      const primary = device.interfaces[0];
      if (!primary?.ip || !primary.mask || !primary.up) {
        addIssue(issues, {
          severity: "critical",
          title: `${device.name}: endpoint address missing`,
          detail: "Endpoint needs an up interface with IP and mask.",
          deviceId: device.id,
          command: "ipconfig",
        });
      }
      if (!device.gateway) {
        addIssue(issues, {
          severity: "critical",
          title: `${device.name}: default gateway missing`,
          detail: "Traffic outside the local subnet cannot leave this endpoint.",
          deviceId: device.id,
          command: "ipconfig",
        });
      } else if (primary?.ip && primary.mask && !ipInSubnet(device.gateway, primary.ip, primary.mask)) {
        addIssue(issues, {
          severity: "critical",
          title: `${device.name}: gateway outside subnet`,
          detail: `${device.gateway} is not inside ${primary.ip}/${maskToPrefix(primary.mask)}.`,
          deviceId: device.id,
          command: "ipconfig",
        });
      } else if (isValidIp(device.gateway)) {
        const result = simulator.analyzeConnectivity(device.id, device.gateway);
        if (!result.ok || !result.targetFound) {
          addIssue(issues, {
            severity: "critical",
            title: `${device.name}: gateway unreachable`,
            detail: result.message.replace(/^% ?/, "") || `Cannot reach ${device.gateway}.`,
            deviceId: device.id,
            command: `ping ${device.gateway}`,
          });
        }
      }
      if (hasDhcp && device.type === "pc" && (!primary?.ip || !device.gateway)) {
        addIssue(issues, {
          severity: "warning",
          title: `${device.name}: DHCP client not configured`,
          detail: "A DHCP service exists, but this PC still lacks usable addressing.",
          deviceId: device.id,
          command: "ipconfig /renew",
        });
      }
      if (hasDns && device.type === "pc") {
        if (!device.dns) {
          addIssue(issues, {
            severity: "warning",
            title: `${device.name}: DNS server missing`,
            detail: "DNS-aware labs should configure a resolver on the client.",
            deviceId: device.id,
            command: "ipconfig",
          });
        } else {
          const dnsDevice = devices.find((candidate) => candidate.services.dns && candidate.interfaces.some((iface) => iface.ip === device.dns));
          if (!dnsDevice) {
            addIssue(issues, {
              severity: "warning",
              title: `${device.name}: DNS resolver not found`,
              detail: `${device.dns} is configured, but no DNS service owns that address.`,
              deviceId: device.id,
              command: "ipconfig",
            });
          }
        }
      }
    }

    if (device.dhcpPools.length) {
      const incomplete = device.dhcpPools.filter((pool) => !pool.network || !pool.mask || !pool.defaultRouter || !pool.dnsServer);
      if (incomplete.length) {
        addIssue(issues, {
          severity: "warning",
          title: `${device.name}: DHCP pool incomplete`,
          detail: `${incomplete.length}/${device.dhcpPools.length} DHCP pools are missing network, gateway, or DNS.`,
          deviceId: device.id,
          command: inspectionCommand(device, "dhcp"),
        });
      }
    }

    if (device.services.dns && !Object.keys(device.dnsRecords).length) {
      addIssue(issues, {
        severity: "warning",
        title: `${device.name}: DNS has no records`,
        detail: "DNS service is enabled but no records are configured.",
        deviceId: device.id,
        command: inspectionCommand(device, "dns"),
      });
    }

    const natRoles = device.interfaces.filter((iface) => iface.natRole).length;
    if (natRoles || device.nat.overloadRules.length) {
      if (natRoles < 2 || !device.nat.overloadRules.length) {
        addIssue(issues, {
          severity: "warning",
          title: `${device.name}: NAT/PAT incomplete`,
          detail: `${natRoles} NAT role interfaces and ${device.nat.overloadRules.length} overload rules are configured.`,
          deviceId: device.id,
          command: inspectionCommand(device, "nat"),
        });
      }
    }

    const aclNames = Object.keys(device.acls);
    const aclEntries = aclNames.reduce((total, name) => total + device.acls[name].entries.length, 0);
    const appliedAcls = device.interfaces.filter((iface) => iface.aclIn || iface.aclOut).length;
    if (aclNames.length || appliedAcls) {
      if (!aclEntries || !appliedAcls) {
        addIssue(issues, {
          severity: aclEntries ? "warning" : "critical",
          title: `${device.name}: ACL configuration incomplete`,
          detail: `${aclEntries} ACL rules and ${appliedAcls} interface attachments found.`,
          deviceId: device.id,
          command: inspectionCommand(device, "acl"),
        });
      }
    }
  });

  lab.links.forEach((link) => {
    const from = lab.devices[link.from];
    const to = lab.devices[link.to];
    const fromIface = getInterface(from, link.fromIf);
    const toIface = getInterface(to, link.toIf);
    if (!from || !to || !fromIface || !toIface) {
      addIssue(issues, {
        severity: "critical",
        title: `${linkTitle(lab, link)}: cable endpoint missing`,
        detail: "The cable references a missing device or interface.",
        linkId: link.id,
      });
    } else if (!fromIface.up || !toIface.up) {
      addIssue(issues, {
        severity: "warning",
        title: `${linkTitle(lab, link)}: interface down`,
        detail: `${from.name}/${fromIface.name} is ${fromIface.up ? "up" : "down"}, ${to.name}/${toIface.name} is ${toIface.up ? "up" : "down"}.`,
        linkId: link.id,
        deviceId: fromIface.up ? to.id : from.id,
        command: inspectionCommand(fromIface.up ? to : from, "interface"),
      });
    }
  });

  if (!issues.length) {
    addIssue(issues, {
      severity: "info",
      title: "No obvious topology problems",
      detail: "Sanity checks and basic gateway reachability did not find a blocking issue.",
    });
  }
  return issues.sort((a, b) => severityRank[a.severity] - severityRank[b.severity] || a.title.localeCompare(b.title));
}

export function flowProblem(flow: FlowState | null): TopologyIssue | null {
  if (!flow) return null;
  const drop = flow.steps.find((step) => step.status === "bad") || flow.steps[flow.steps.length - 1];
  if (!drop && flow.success) return {
    id: "flow-ok",
    severity: "info",
    title: "Last test succeeded",
    detail: `${flow.sourceName} reached ${flow.target}.`,
  };
  if (!drop) return null;
  return {
    id: `flow-${drop.kind}`,
    severity: flow.success ? "info" : "critical",
    title: flow.success ? "Last test succeeded" : `${drop.label}: ${flow.sourceName} -> ${flow.target}`,
    detail: drop.detail,
    deviceId: drop.deviceId,
    linkId: drop.linkId,
  };
}

export function diagnosticActionsForFlow(lab: LabState, flow: FlowState | null): DiagnosticAction[] {
  const issue = flowProblem(flow);
  if (!issue) return [];
  const device = issue.deviceId ? lab.devices[issue.deviceId] : null;
  if (!device) return [];
  const lower = issue.detail.toLowerCase();
  const actions: DiagnosticAction[] = [];
  const add = (label: string, command: string) => actions.push({ label, command, deviceId: device.id });
  if (lower.includes("route") || lower.includes("gateway") || lower.includes("next hop")) add("Show routes", inspectionCommand(device, "route"));
  if (lower.includes("interface") || lower.includes("shutdown") || lower.includes("layer-2")) add("Show interfaces", inspectionCommand(device, "interface"));
  if (lower.includes("acl") || lower.includes("deny")) add("Show ACLs", inspectionCommand(device, "acl"));
  if (lower.includes("nat")) add("Show NAT", inspectionCommand(device, "nat"));
  if (!actions.length) {
    add("Inspect interfaces", inspectionCommand(device, "interface"));
    if (device.type === "router" || device.type === "cloud") add("Inspect routes", inspectionCommand(device, "route"));
  }
  return actions.slice(0, 3);
}

export function buildProjectExport(lab: LabState) {
  return { version: 3, exportedAt: new Date().toISOString(), lab };
}

export function buildHtmlReport(lab: LabState): string {
  const devices = Object.values(lab.devices);
  const minX = Math.min(0, ...devices.map((device) => device.x));
  const minY = Math.min(0, ...devices.map((device) => device.y));
  const maxX = Math.max(1000, ...devices.map((device) => device.x + 170));
  const maxY = Math.max(430, ...devices.map((device) => device.y + 120));
  const width = maxX - minX + 40;
  const height = maxY - minY + 40;
  const deviceCenter = (device: Device) => ({ x: device.x - minX + 105, y: device.y - minY + 78 });
  const links = lab.links.map((link) => {
    const from = lab.devices[link.from];
    const to = lab.devices[link.to];
    if (!from || !to) return "";
    const start = deviceCenter(from);
    const end = deviceCenter(to);
    return `<line x1="${start.x}" y1="${start.y}" x2="${end.x}" y2="${end.y}" /><text x="${(start.x + end.x) / 2}" y="${(start.y + end.y) / 2 - 6}">${html(link.fromIf)} - ${html(link.toIf)}</text>`;
  }).join("");
  const nodes = devices.map((device) => {
    const x = device.x - minX + 20;
    const y = device.y - minY + 20;
    return `<g><rect x="${x}" y="${y}" width="170" height="78" /><text x="${x + 10}" y="${y + 22}">${html(device.name)}</text><text x="${x + 10}" y="${y + 44}">${html(device.type.toUpperCase())}</text></g>`;
  }).join("");
  const deviceSections = devices.map((device) => {
    const interfaces = device.interfaces.map((iface) => `<li>${html(iface.name)}: ${html(iface.ip || "--")} ${html(iface.mask || "")} ${iface.up ? "up" : "down"}</li>`).join("");
    const transcript = (device.cli.terminalLines || []).map((line) => html(line)).join("\n") || "No CLI transcript for this device.";
    const history = (device.cli.history || []).map((line) => `<li><code>${html(line)}</code></li>`).join("") || "<li>No command history.</li>";
    return `<section><h2>${html(device.name)}</h2><h3>Interfaces</h3><ul>${interfaces}</ul><h3>Running config</h3><pre>${html(runningConfig(device))}</pre><h3>Commands</h3><ol>${history}</ol><h3>CLI transcript</h3><pre>${transcript}</pre></section>`;
  }).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Netpket Report - ${html(lab.currentScenarioId)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
    h1, h2, h3 { margin-bottom: 8px; }
    section { border-top: 2px solid #111; padding-top: 16px; margin-top: 22px; }
    pre, code { font-family: Consolas, ui-monospace, monospace; }
    pre { background: #111; color: #d8fff8; padding: 12px; overflow: auto; }
    svg { width: 100%; max-width: 1100px; border: 1px solid #111; background: #f5f5f5; }
    line { stroke: #222; stroke-width: 2; }
    rect { fill: #fff; stroke: #111; stroke-width: 1; }
    text { font-family: Consolas, ui-monospace, monospace; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Netpket Lab Report</h1>
  <p>Scenario: ${html(lab.currentScenarioId)} | Exported: ${html(new Date().toLocaleString())}</p>
  <h2>Topology</h2>
  <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Netpket topology">${links}${nodes}</svg>
  ${deviceSections}
</body>
</html>`;
}
