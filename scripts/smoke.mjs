import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const port = 4175;
const baseUrl = `http://127.0.0.1:${port}`;

const server = spawn("npm", ["run", "dev", "--", "--port", String(port)], {
  cwd: new URL("..", import.meta.url),
  stdio: ["ignore", "pipe", "pipe"],
});

let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      await delay(150);
    }
  }
  throw new Error(`Vite server did not start.\n${serverOutput}`);
}

async function runCommand(page, command) {
  const input = page.locator(".terminal-input-row input");
  await input.fill(command);
  await input.press("Enter");
  await page.waitForTimeout(30);
}

async function runCommands(page, commands) {
  for (const command of commands) {
    await runCommand(page, command);
  }
}

async function guideCoverage(page) {
  await page.getByRole("dialog", { name: "Netpket Guide" }).waitFor({ timeout: 3000 });
  await page.getByText("1. Choose Scenario", { exact: true }).waitFor();
  await page.getByText("4. Validate", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Start Lab" }).click();
  await page.getByRole("dialog", { name: "Netpket Guide" }).waitFor({ state: "hidden" });
  await page.getByRole("button", { name: "Guide" }).click();
  await page.getByRole("dialog", { name: "Netpket Guide" }).waitFor();
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("dialog", { name: "Netpket Guide" }).waitFor({ state: "hidden" });
  const topbarHeight = await page.locator(".topbar").evaluate((node) => Math.round(node.getBoundingClientRect().height));
  if (topbarHeight > 62) throw new Error(`Topbar wrapped or is too tall: ${topbarHeight}px.`);
}

async function endpoint(page, deviceId, ip, mask, gateway, dns = "") {
  await runCommand(page, `select ${deviceId}`);
  await page.locator("#edit-ip").fill(ip);
  await page.locator("#edit-mask").fill(mask);
  await page.locator("#edit-gateway").fill(gateway);
  await page.locator("#edit-dns").fill(dns);
  await page.getByRole("button", { name: "Apply Fields" }).click();
}

async function selectScenario(page, scenarioId) {
  if (await page.locator("#scenario-panel").isHidden()) {
    await page.getByRole("button", { name: "Show scenarios panel" }).click();
  }
  await page.locator(`[data-scenario-id="${scenarioId}"]`).click();
  await page.waitForTimeout(100);
}

async function assertEndpointBadgesDoNotOverlap(page) {
  const boxes = await page.locator(".link-badge.endpoint-label rect").evaluateAll((nodes) => nodes.map((node, index) => {
    const rect = node.getBoundingClientRect();
    return {
      index,
      label: node.parentElement?.textContent?.trim() || `badge-${index}`,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    };
  }));
  for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
      const left = boxes[leftIndex];
      const right = boxes[rightIndex];
      const overlapX = Math.min(left.right, right.right) - Math.max(left.left, right.left);
      const overlapY = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
      if (overlapX > 1 && overlapY > 1) {
        throw new Error(`Endpoint badges overlap: ${left.label} and ${right.label}.`);
      }
    }
  }
}

async function validate(page, expected) {
  await page.getByRole("button", { name: "Validate Scenario" }).click();
  await page.waitForTimeout(120);
  await page.getByText(expected, { exact: false }).waitFor({ timeout: 3000 });
}

async function clickFirstCable(page) {
  const point = await page.locator(".link-hit").first().evaluate((path) => {
    const svgPath = path;
    const totalLength = svgPath.getTotalLength();
    const svgPoint = svgPath.getPointAtLength(totalLength / 2);
    const matrix = svgPath.getScreenCTM();
    if (!matrix) throw new Error("Missing SVG transform matrix.");
    return {
      x: svgPoint.x * matrix.a + svgPoint.y * matrix.c + matrix.e,
      y: svgPoint.x * matrix.b + svgPoint.y * matrix.d + matrix.f,
    };
  });
  await page.mouse.click(point.x, point.y);
}

async function emptyScenarioOne(page) {
  await selectScenario(page, "s1");
  await validate(page, "0/3 checks passed");
  await page.locator(".objective-item.active").waitFor();
  await page.locator(".fix-check").first().click();
  const hintedCommand = await page.locator(".terminal-input-row input").inputValue();
  if (!hintedCommand) throw new Error("Validation fix hint did not prefill a useful CLI command.");
}

async function blankWorkspaceBuilder(page) {
  await selectScenario(page, "blank");
  await validate(page, "1/1 checks passed");
  const workspace = page.locator(".workspace");
  const box = await workspace.boundingBox();
  if (!box) throw new Error("Could not measure workspace for context menu.");
  await page.mouse.click(box.x + 260, box.y + 160, { button: "right" });
  await page.getByRole("menu", { name: "Add device" }).waitFor();
  await page.getByRole("menuitem", { name: "Router" }).click();
  await page.locator(".device-node").filter({ hasText: "R1" }).waitFor();
  await page.mouse.click(box.x + 470, box.y + 190, { button: "right" });
  await page.getByRole("menuitem", { name: "PC" }).click();
  await page.locator(".device-node").filter({ hasText: "PC1" }).waitFor();
  if (await page.locator(".device-glyph").count() < 2) throw new Error("Context-created device icons did not render.");
  await page.locator(".device-node.selected").filter({ hasText: "PC1" }).waitFor();
  await page.getByRole("button", { name: "Add Interface" }).click();
  await page.locator(".prebox").filter({ hasText: "eth1: unconfigured" }).waitFor();
  await page.getByRole("button", { name: "Start Cable" }).click();
  await page.locator(".device-node").filter({ hasText: "R1" }).click();
  await page.locator(".link-hit").first().waitFor();
  await clickFirstCable(page);
  await page.getByRole("button", { name: "Delete Cable" }).click();
  if (await page.locator(".link-hit").count() !== 0) throw new Error("Cable was not deleted from blank workspace.");
  await page.locator(".device-node").filter({ hasText: "R1" }).click();
  await page.getByRole("button", { name: "Delete Device" }).click();
  if (await page.locator(".device-node").filter({ hasText: "R1" }).count() !== 0) throw new Error("Device delete did not remove R1.");
}

async function recipeBuilder(page) {
  await page.getByLabel("Recipe router count").fill("4");
  await page.getByLabel("Inner address pattern").fill("15+1.38.47.1");
  await page.getByLabel("Inner mask").fill("255.255.255.252");
  await page.getByLabel("Outer address pattern").fill("15+10.1.1.1");
  await page.getByLabel("Outer mask").fill("255.255.255.0");
  await page.getByText("R1-R2: 15.38.47.1 - 15.38.47.2").waitFor();
  await page.getByText("R4 LAN: gateway 45.1.1.1").waitFor();
  await page.getByRole("button", { name: "Build Recipe Lab" }).click();
  await page.locator(".device-node").filter({ hasText: "R4" }).waitFor();
  await validate(page, "5/5 checks passed");
  await runCommand(page, "select pc1");
  await runCommand(page, "ping 15.1.1.1");
  await page.getByText("Reply from 15.1.1.1", { exact: false }).waitFor();
  await page.locator(".debug-summary.ok").waitFor();
  await page.locator(".packet-dot").waitFor();
  await page.locator(".flow-route-path").waitFor();
  await page.locator(".flow-step").filter({ hasText: "Source" }).waitFor();
  await page.locator(".flow-step").filter({ hasText: "Destination" }).waitFor();
}

async function scenarioOne(page) {
  await selectScenario(page, "s1");
  await runCommands(page, [
    "select r1", "en", "conf t", "int g0/0", "ip address 192.168.10.1 255.255.255.0", "no shut",
    "interface g0/1", "description spare-uplink", "interface g0/0", "end",
  ]);
  await runCommand(page, "show running-config interface g0/1");
  await page.getByText("description spare-uplink", { exact: true }).waitFor();
  await endpoint(page, "pc1", "192.168.10.10", "255.255.255.0", "192.168.10.1");
  await validate(page, "3/3 checks passed");
}

async function qolCommandCoverage(page) {
  if (await page.locator(".device-glyph").count() < 3) throw new Error("Device type icons did not render.");
  if (await page.locator(".service-lamp").count() < 3) throw new Error("Device service lamps did not render.");
  if (await page.locator(".issue-badge").count() < 3) throw new Error("Device issue badges did not render.");
  await page.getByRole("button", { name: "Fit" }).click();
  await page.getByRole("button", { name: "Center" }).click();
  await page.locator(".splitter-right").waitFor();
  await page.locator(".link-path").first().waitFor();
  if (await page.locator(".link-label.endpoint-label").count() < 2) throw new Error("Endpoint-near link labels did not render.");
  if (await page.locator(".link-badge rect").count() < 2) throw new Error("Interface label plaques did not render.");
  await clickFirstCable(page);
  await page.getByText("Endpoints", { exact: true }).waitFor();
  await page.locator(".link-endpoints button").first().click();
  await page.getByText("Quick Actions", { exact: true }).waitFor();
  await page.keyboard.press("Control+K");
  await page.locator(".command-palette").waitFor();
  await page.getByLabel("Command palette search").fill("fit");
  await page.keyboard.press("Enter");
  await page.locator(".command-palette").waitFor({ state: "hidden" });
  if (await page.locator(".cli-hints button").count() < 1) throw new Error("CLI hint chips did not render.");

  const draggableRouter = page.locator(".device-node").filter({ hasText: "R1" }).first();
  const beforeDragLeft = await draggableRouter.evaluate((node) => Number.parseFloat(node.style.left || "0"));
  const routerBox = await draggableRouter.boundingBox();
  if (!routerBox) throw new Error("Could not measure router before drag.");
  await page.mouse.move(routerBox.x + routerBox.width / 2, routerBox.y + 14);
  await page.mouse.down();
  await page.mouse.move(routerBox.x + routerBox.width / 2 + 480, routerBox.y + 240, { steps: 18 });
  await page.mouse.up();
  await page.waitForTimeout(120);
  const afterDragLeft = await draggableRouter.evaluate((node) => Number.parseFloat(node.style.left || "0"));
  if (afterDragLeft < beforeDragLeft + 300) throw new Error(`Workspace drag still appears clamped: before ${beforeDragLeft}, after ${afterDragLeft}.`);
  await page.getByRole("button", { name: "Fit" }).click();

  await runCommand(page, "select r1");
  await runCommand(page, "en");
  await runCommand(page, "show running-config interface g0/0");
  await page.getByText("interface g0/0", { exact: true }).waitFor();
  await page.getByText("ip address 192.168.10.1 255.255.255.0", { exact: true }).waitFor();
  await runCommand(page, "show interfaces description");
  await page.getByText("Interface              Status  Description", { exact: false }).waitFor();
  await runCommand(page, "sh run int g0/0");
  if (await page.locator(".terminal-history").getByText("no shutdown", { exact: true }).count() < 1) {
    throw new Error("show run interface alias did not print no shutdown.");
  }
  await runCommand(page, "?");
  await page.getByText("Possible commands:", { exact: false }).waitFor();

  const input = page.locator(".terminal-input-row input");
  await input.fill("conf");
  await input.press("Tab");
  await page.waitForTimeout(30);
  const completed = await input.inputValue();
  if (completed !== "configure terminal ") throw new Error(`Tab completion failed, got '${completed}'`);

  await runCommand(page, "clear");
  const terminalText = await page.locator(".terminal-history").innerText();
  if (terminalText.trim()) throw new Error(`clear did not empty terminal history: ${terminalText}`);
  await runCommand(page, "help");
  await page.getByText("IOS-like commands:", { exact: false }).waitFor();
  await runCommand(page, "cls");
  const terminalTextAfterCls = await page.locator(".terminal-history").innerText();
  if (terminalTextAfterCls.trim()) throw new Error(`cls did not empty terminal history: ${terminalTextAfterCls}`);
  await runCommand(page, "select r1; en; show ip route");
  await page.locator(".terminal-history").getByText("C 192.168.10.0/24", { exact: false }).waitFor();
  await page.locator(".terminal-line.command").first().waitFor();
  await runCommand(page, "ping 192.168.10.10");
  await page.getByText("Reply from 192.168.10.10", { exact: false }).waitFor();
  await page.locator(".terminal-line.success").first().waitFor();
  await runCommand(page, "show running-config interface g9/9");
  await page.locator(".terminal-line.error").last().waitFor();
  await page.locator(".cli-hints .error-hint").first().waitFor();

  await page.locator(".panel-title-button").click();
  await page.waitForTimeout(60);
  if (!(await page.locator("#scenario-panel").isHidden())) throw new Error("Scenario panel title Hide button did not hide the panel.");
  await page.getByRole("button", { name: "Show scenarios panel" }).click();
  await page.waitForTimeout(60);
  if (await page.locator("#scenario-panel").isHidden()) throw new Error("Scenario rail did not show the panel.");
  await page.locator(".sidebar-toggle-grip").click();
  await page.waitForTimeout(60);
  if (!(await page.locator("#scenario-panel").isHidden())) throw new Error("Scenario splitter grip did not hide the panel.");
  await page.getByRole("button", { name: "Show scenarios panel" }).click();
  await page.waitForTimeout(60);

  await page.getByRole("button", { name: "Hide Scenarios", exact: true }).click();
  await page.waitForTimeout(60);
  if (!(await page.locator("#scenario-panel").isHidden())) throw new Error("Scenario panel did not hide.");
  const workspaceLeftAfterHide = await page.locator(".workspace-panel").evaluate((node) => Math.round(node.getBoundingClientRect().left));
  if (workspaceLeftAfterHide > 40) throw new Error(`Workspace did not expand into the hidden scenarios panel space: left=${workspaceLeftAfterHide}px.`);
  await page.locator(".scenario-rail").waitFor();
  await page.locator(".scenario-rail").click();
  await page.waitForTimeout(60);
  if (await page.locator("#scenario-panel").isHidden()) throw new Error("Scenario panel did not show.");
}

async function scenarioTwo(page) {
  await selectScenario(page, "s2");
  await page.locator(".link-badge.endpoint-label rect").first().waitFor();
  await assertEndpointBadgesDoNotOverlap(page);
  await runCommands(page, [
    "select r1", "en", "conf t", "int g0/0", "ip address 192.168.20.1 255.255.255.0", "no shut", "exit",
    "ip dhcp excluded-address 192.168.20.1 192.168.20.20",
    "ip dhcp pool LAN", "network 192.168.20.0 255.255.255.0", "default-router 192.168.20.1", "dns-server 8.8.8.8", "end",
    "select pc1", "ipconfig /renew", "select pc2", "ipconfig /renew",
  ]);
  await validate(page, "6/6 checks passed");
}

async function scenarioThree(page) {
  await selectScenario(page, "s3");
  await runCommands(page, [
    "select r1", "en", "conf t", "int g0/0", "ip address 192.168.30.1 255.255.255.0", "no shut", "exit",
    "int g0/1", "ip address 10.10.10.1 255.255.255.0", "no shut", "end",
  ]);
  await endpoint(page, "pc1", "192.168.30.10", "255.255.255.0", "192.168.30.1", "10.10.10.10");
  await validate(page, "5/5 checks passed");
}

async function servicesAndQosCoverage(page) {
  await runCommand(page, "select srv1");
  await page.getByLabel("Server Services").waitFor();
  await page.locator(".server-services input[name='network']").fill("192.168.30.0");
  await page.locator(".server-services input[name='mask']").fill("255.255.255.0");
  await page.locator(".server-services input[name='gateway']").fill("192.168.30.1");
  await page.locator(".server-services input[name='dns']").fill("10.10.10.10");
  await page.locator(".server-services input[name='start']").fill("192.168.30.40");
  await page.locator(".server-services input[name='end']").fill("192.168.30.45");
  await page.getByRole("button", { name: "Save DHCP" }).click();
  await page.getByText("SERVER_POOL: 192.168.30.0 / 255.255.255.0", { exact: false }).waitFor();
  await page.getByRole("tab", { name: "DNS" }).click();
  await page.locator(".server-services input[name='name']").fill("mail.local");
  await page.locator(".server-services input[name='ip']").fill("10.10.10.10");
  await page.getByRole("button", { name: "Add DNS" }).click();
  await page.locator(".server-services .service-row span").getByText("mail.local -> 10.10.10.10", { exact: false }).waitFor();
  await page.getByRole("tab", { name: "WWW" }).click();
  await page.locator(".server-services textarea[name='content']").fill("Netpket custom WWW page");
  await page.getByRole("button", { name: "Save WWW" }).click();
  await page.locator(".service-preview").getByText("Netpket custom WWW page", { exact: false }).waitFor();
  await page.getByRole("tab", { name: "MAIL" }).click();
  await page.locator(".server-services input[name='user']").fill("admin");
  await page.getByRole("button", { name: "Add Mailbox" }).click();
  await page.getByText("admin: 0 message(s)", { exact: false }).waitFor();
  await runCommands(page, [
    "select pc1", "ipconfig /renew", "nslookup intranet.local", "curl intranet.local",
    "select srv1", "show services",
  ]);
  await runCommand(page, "select pc1");
  await page.locator(".terminal-history").getByText("DHCP lease acquired", { exact: false }).waitFor();
  await page.locator(".terminal-line.output").filter({ hasText: "Netpket custom WWW page" }).first().waitFor();
  await runCommand(page, "select srv1");
  await page.locator(".terminal-line.output").filter({ hasText: /^MAIL\s+enabled$/ }).waitFor();
  await runCommands(page, [
    "select pc1", "mail send mail.local admin hello from smoke",
    "select srv1", "show mail admin",
  ]);
  await runCommand(page, "select pc1");
  await page.locator(".terminal-history").getByText("250 OK: queued mail for admin", { exact: false }).waitFor();
  await runCommand(page, "select srv1");
  await page.locator(".terminal-line.output").getByText("hello from smoke", { exact: false }).waitFor();
  await runCommands(page, [
    "select r1", "en", "conf t", "mls qos", "class-map match-any WEB", "match protocol http", "exit",
    "policy-map APPQOS", "class WEB", "priority percent 30", "set dscp af31", "exit",
    "int g0/1", "service-policy output APPQOS", "end", "show policy-map", "show running-config interface g0/1",
  ]);
  await page.locator(".terminal-history").getByText("Policy Map APPQOS", { exact: false }).waitFor();
  await page.locator(".terminal-history").getByText("service-policy output APPQOS", { exact: true }).waitFor();
  await runCommands(page, ["select pc1", "curl intranet.local"]);
  await page.locator(".flow-step.qos").filter({ hasText: "R1/g0/1 applies APPQOS" }).waitFor();
}

async function dynamicRoutingCoverage(page) {
  await selectScenario(page, "s4");
  await endpoint(page, "pc1", "192.168.40.10", "255.255.255.0", "192.168.40.1");
  await endpoint(page, "pc2", "192.168.41.10", "255.255.255.0", "192.168.41.1");
  await runCommands(page, [
    "select r1", "en", "conf t", "int g0/0", "ip address 192.168.40.1 255.255.255.0", "no sh", "exit",
    "int g0/1", "ip address 10.0.12.1 255.255.255.252", "no sh", "exit",
    "router rip", "version 2", "no auto-summary", "network 192.168.40.0", "network 10.0.12.0", "end",
  ]);
  await page.locator(".routing-status-link.bad").waitFor({ state: "attached", timeout: 3000 });
  await runCommands(page, [
    "select r2", "en", "conf t", "int g0/0", "ip address 10.0.12.2 255.255.255.252", "no sh", "exit",
    "int g0/1", "ip address 192.168.41.1 255.255.255.0", "no sh", "exit",
    "router rip", "version 2", "no auto-summary", "network 10.0.12.0", "network 192.168.41.0", "end",
    "select r1", "show ip protocols", "show ip route",
  ]);
  await page.locator(".routing-status-link.ok").waitFor({ state: "attached", timeout: 3000 });
  await page.locator(".terminal-history").getByText("Routing Protocol is \"rip\"", { exact: false }).waitFor();
  await page.locator(".terminal-history").getByText("R 192.168.41.0/24", { exact: false }).waitFor();
  await runCommands(page, [
    "select r1", "conf t", "router egrip 10", "network 192.168.40.0 0.0.0.255", "network 10.0.12.0 0.0.0.3", "end",
    "select r2", "conf t", "router eigrp 10", "network 10.0.12.0 0.0.0.3", "network 192.168.41.0 0.0.0.255", "end",
    "select r1", "show ip protocols", "show ip route",
  ]);
  await page.locator(".terminal-history").getByText("Routing Protocol is \"eigrp 10\"", { exact: false }).waitFor();
  await page.locator(".terminal-history").getByText("D 192.168.41.0/24", { exact: false }).waitFor();
  await runCommands(page, ["select pc1", "ping 192.168.41.10"]);
  await page.locator(".terminal-history").getByText("Reply from 192.168.41.10", { exact: false }).waitFor();
}

async function scenarioFour(page) {
  await selectScenario(page, "s4");
  await endpoint(page, "pc1", "192.168.40.10", "255.255.255.0", "192.168.40.1");
  await endpoint(page, "pc2", "192.168.41.10", "255.255.255.0", "192.168.41.1");
  await runCommands(page, [
    "select r1", "en", "conf t", "int g0/0", "ip address 192.168.40.1 255.255.255.0", "no shut", "exit",
    "int g0/1", "ip address 10.0.12.1 255.255.255.252", "no shut", "exit",
    "ip route 192.168.41.0 255.255.255.0 10.0.12.2", "end",
    "select r2", "en", "conf t", "int g0/0", "ip address 10.0.12.2 255.255.255.252", "no shut", "exit",
    "int g0/1", "ip address 192.168.41.1 255.255.255.0", "no shut", "exit",
    "ip route 192.168.40.0 255.255.255.0 10.0.12.1", "end",
  ]);
  await validate(page, "5/5 checks passed");
  await runCommands(page, ["select pc1", "ping 192.168.41.10"]);
  await page.locator(".terminal-history").getByText("Reply from 192.168.41.10", { exact: false }).waitFor();
}

async function staticRouteInterfaceCoverage(page) {
  await selectScenario(page, "s4");
  await endpoint(page, "pc1", "192.168.40.10", "255.255.255.0", "192.168.40.1");
  await endpoint(page, "pc2", "192.168.41.10", "255.255.255.0", "192.168.41.1");
  await runCommands(page, [
    "select r1", "en", "conf t", "int g0/0", "ip address 192.168.40.1 255.255.255.0", "no shut", "exit",
    "int g0/1", "ip address 10.0.12.1 255.255.255.252", "no shut", "exit",
    "ip route 192.168.41.0 255.255.255.0 g0/1 10.0.12.2", "end",
    "select r2", "en", "conf t", "int g0/0", "ip address 10.0.12.2 255.255.255.252", "no shut", "exit",
    "int g0/1", "ip address 192.168.41.1 255.255.255.0", "no shut", "exit",
    "ip route 192.168.40.0 255.255.255.0 g0/0 10.0.12.1", "end",
    "select r1", "show running-config",
  ]);
  await page.locator(".terminal-line.output").getByText("ip route 192.168.41.0 255.255.255.0 g0/1 10.0.12.2", { exact: true }).waitFor();
  await validate(page, "5/5 checks passed");
  await runCommands(page, ["select pc1", "ping 192.168.41.10"]);
  await page.locator(".terminal-history").getByText("Reply from 192.168.41.10", { exact: false }).last().waitFor();
  await runCommands(page, [
    "select r1", "conf t", "ip route 192.168.41.0 255.255.255.0 g0/1", "end",
    "select r2", "conf t", "ip route 192.168.40.0 255.255.255.0 g0/0", "end",
    "select r1", "show running-config",
  ]);
  await page.locator(".terminal-line.output").getByText("ip route 192.168.41.0 255.255.255.0 g0/1", { exact: true }).waitFor();
  await validate(page, "5/5 checks passed");
  await runCommands(page, ["select pc1", "ping 192.168.41.10"]);
  await page.locator(".terminal-history").getByText("Reply from 192.168.41.10", { exact: false }).last().waitFor();
}

async function scenarioFive(page) {
  await selectScenario(page, "s5");
  await endpoint(page, "pc1", "192.168.50.10", "255.255.255.0", "192.168.50.1");
  await runCommands(page, [
    "select r1", "en", "conf t", "int g0/0", "ip address 192.168.50.1 255.255.255.0", "no shut", "ip nat inside", "exit",
    "int g0/1", "ip address 203.0.113.2 255.255.255.252", "no shut", "ip nat outside", "exit",
    "ip route 0.0.0.0 0.0.0.0 203.0.113.1",
    "ip access-list extended NATLAN", "permit ip 192.168.50.0 0.0.0.255 any", "exit",
    "ip nat inside source list NATLAN interface g0/1 overload", "end",
    "select pc1", "curl 198.51.100.10",
  ]);
  await validate(page, "6/6 checks passed");
}

async function scenarioSix(page) {
  await selectScenario(page, "s6");
  await runCommands(page, [
    "select r1", "en", "conf t", "ip access-list extended WEBPOLICY",
    "deny tcp 192.168.60.10 0.0.0.0 10.60.0.10 0.0.0.0 eq 80",
    "permit udp 192.168.60.10 0.0.0.0 10.60.0.10 0.0.0.0 eq 53",
    "permit tcp 192.168.60.20 0.0.0.0 10.60.0.10 0.0.0.0 eq 80",
    "permit ip any any", "exit", "int g0/1", "ip access-group WEBPOLICY out", "end",
  ]);
  await validate(page, "5/5 checks passed");
}

async function scenarioSixBadAclOrder(page) {
  await selectScenario(page, "s6");
  await runCommands(page, [
    "select r1", "en", "conf t", "ip access-list extended WEBPOLICY",
    "permit tcp 192.168.60.10 0.0.0.0 10.60.0.10 0.0.0.0 eq 80",
    "deny tcp 192.168.60.10 0.0.0.0 10.60.0.10 0.0.0.0 eq 80",
    "permit udp 192.168.60.10 0.0.0.0 10.60.0.10 0.0.0.0 eq 53",
    "permit tcp 192.168.60.20 0.0.0.0 10.60.0.10 0.0.0.0 eq 80",
    "permit ip any any", "exit", "int g0/1", "ip access-group WEBPOLICY out", "end",
  ]);
  await validate(page, "3/5 checks passed");
}

async function scenarioSeven(page) {
  await selectScenario(page, "s7");
  await endpoint(page, "pc1", "192.168.70.10", "255.255.255.0", "192.168.70.1", "10.70.10.10");
  await runCommands(page, [
    "select r1", "en", "conf t", "int g0/1", "no shut", "exit",
    "ip route 10.70.10.0 255.255.255.0 10.0.72.2",
    "ip dhcp pool OFFICE", "default-router 192.168.70.1", "exit",
    "ip access-list extended WEBGUARD", "no 10", "exit", "end",
    "select pc2", "ipconfig /renew",
  ]);
  await validate(page, "7/7 checks passed");
}

async function terminalWorkbenchCoverage(page) {
  await selectScenario(page, "s1");
  await runCommands(page, [
    "select r1", "en", "conf t", "int g0/0", "ip address 192.168.10.1 255.255.255.0", "no shut", "end",
  ]);
  await endpoint(page, "pc1", "192.168.10.10", "255.255.255.0", "192.168.10.1");

  await runCommand(page, "select r1");
  await runCommand(page, "show ip route");
  await page.locator(".terminal-history").getByText("C 192.168.10.0/24", { exact: false }).waitFor();
  await runCommand(page, "select pc1");
  await runCommand(page, "ipconfig");
  await page.locator(".terminal-history").getByText("192.168.10.10", { exact: false }).waitFor();
  const pcTerminal = await page.locator(".terminal-history").innerText();
  if (pcTerminal.includes("C 192.168.10.0/24")) throw new Error("PC terminal leaked R1 route history.");
  await runCommand(page, "clear");
  const clearedPcTerminal = await page.locator(".terminal-history").innerText();
  if (clearedPcTerminal.trim()) throw new Error(`clear did not empty only the active PC terminal: ${clearedPcTerminal}`);
  await runCommand(page, "select r1");
  await page.locator(".terminal-history").getByText("C 192.168.10.0/24", { exact: false }).waitFor();
  const r1Terminal = await page.locator(".terminal-history").innerText();
  if (r1Terminal.includes("192.168.10.10")) throw new Error("R1 terminal leaked PC command output.");

  await page.getByRole("button", { name: "Export", exact: true }).click();
  await runCommands(page, ["select pc1", "ping 203.0.113.1"]);
  await page.getByRole("button", { name: "Export HTML Report" }).waitFor();
  await page.getByRole("button", { name: /Test Debug/ }).click();
  await page.locator(".debug-summary.bad").waitFor();
  await page.locator(".flow-step.bad").first().waitFor();
  if (await page.locator(".debug-summary .tool-actions button").count() < 1) throw new Error("Test Debug did not expose diagnostic actions.");
  await page.locator(".debug-summary .tool-actions button").first().click();
  if (!(await page.locator(".terminal-input-row input").inputValue()).trim()) throw new Error("Diagnostic action did not prefill a command.");

  await page.getByRole("button", { name: /Topology Scan/ }).click();
  await page.getByRole("button", { name: "Run Topology Scan" }).click();
  await page.locator(".topology-issue").first().waitFor();
  if (await page.locator(".topology-issue").count() < 1) throw new Error("Topology Scan did not render issues.");
  await page.locator(".topology-issue").first().click();
  if (!(await page.locator(".terminal-input-row input").inputValue()).trim()) throw new Error("Topology issue click did not prefill a command.");

  await page.getByRole("button", { name: "Export", exact: true }).click();
  const [jsonDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download Project JSON" }).click(),
  ]);
  const jsonPath = await jsonDownload.path();
  if (!jsonPath) throw new Error("Project JSON download did not produce a local path.");
  const jsonText = await readFile(jsonPath, "utf8");
  if (!jsonText.includes("\"terminalLines\"") || !jsonText.includes("\"commandDraft\"")) {
    throw new Error("Project JSON export does not include per-device terminal state.");
  }

  const [htmlDownload] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export HTML Report" }).click(),
  ]);
  const htmlPath = await htmlDownload.path();
  if (!htmlPath) throw new Error("HTML report download did not produce a local path.");
  const htmlText = await readFile(htmlPath, "utf8");
  for (const expected of ["Running config", "Commands", "CLI transcript", "R1", "PC1"]) {
    if (!htmlText.includes(expected)) throw new Error(`HTML report missed '${expected}'.`);
  }

  await selectScenario(page, "blank");
  await page.setInputFiles("input[type='file']", jsonPath);
  await page.locator(".device-node").filter({ hasText: "R1" }).waitFor();
  await runCommand(page, "select r1");
  await page.locator(".terminal-history").getByText("C 192.168.10.0/24", { exact: false }).waitFor();
}

try {
  await waitForServer();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator(".brand-logo").waitFor();
  await guideCoverage(page);
  await page.locator(".device-node").first().waitFor();
  await emptyScenarioOne(page);
  await blankWorkspaceBuilder(page);
  await recipeBuilder(page);
  await scenarioOne(page);
  await qolCommandCoverage(page);
  await scenarioTwo(page);
  await scenarioThree(page);
  await servicesAndQosCoverage(page);
  await dynamicRoutingCoverage(page);
  await scenarioFour(page);
  await staticRouteInterfaceCoverage(page);
  await scenarioFive(page);
  await scenarioSixBadAclOrder(page);
  await scenarioSix(page);
  await scenarioSeven(page);
  await terminalWorkbenchCoverage(page);
  await page.setViewportSize({ width: 390, height: 850 });
  await page.getByText("Logical Workspace").waitFor();
  const mobileOverflow = await page.locator(".terminal-panel").evaluate((node) => node.scrollWidth - node.clientWidth);
  if (mobileOverflow > 2) throw new Error(`Mobile CLI overflows horizontally by ${mobileOverflow}px.`);
  await browser.close();
  if (consoleErrors.length) throw new Error(`Console errors:\n${consoleErrors.join("\n")}`);
  console.log("Smoke tests passed: render, logo, onboarding guide, blank workspace builder, right-click device creation, manual interfaces, cabling, ortho link routing, packet animation, cable/device deletion, scenario switching, CLI configuration, per-device terminals, workbench debug/scan/export/import, multi-command CLI paste, colored CLI output, CLI error hints, CLI QoL, badges/lamps, link inspector, command palette, collapsible panel, validation, RIP, EIGRP, QoS, NAT, ACL, DHCP, DNS, HTTP, MAIL, mobile viewport.");
} finally {
  server.kill("SIGTERM");
}
