export type DeviceType = "router" | "switch" | "pc" | "server" | "cloud";
export type InterfaceNatRole = "inside" | "outside" | null;
export type CliMode = "user" | "privileged" | "config" | "interface" | "dhcp" | "acl" | "routing" | "class-map" | "policy-map";
export type Protocol = "ip" | "icmp" | "tcp" | "udp";
export type AclAction = "permit" | "deny";
export type RoutingProtocol = "rip" | "eigrp";

export interface NetworkInterface {
  name: string;
  ip: string;
  mask: string;
  up: boolean;
  natRole?: InterfaceNatRole;
  aclIn?: string | null;
  aclOut?: string | null;
  description?: string;
  helperAddress?: string;
  servicePolicyIn?: string;
  servicePolicyOut?: string;
}

export interface IpRange {
  start: string;
  end: string;
}

export interface DhcpPool {
  name: string;
  network: string;
  mask: string;
  start?: string;
  end?: string;
  defaultRouter: string;
  dnsServer: string;
  excludedRanges?: IpRange[];
}

export interface DhcpBinding {
  ip: string;
  mask: string;
  gateway: string;
  dns: string;
  client: string;
  clientId: string;
  pool: string;
  leasedAt: string;
}

export interface StaticRoute {
  network: string;
  mask: string;
  nextHop: string;
  interface?: string;
  metric?: number;
}

export interface AclEndpoint {
  value: string;
  wildcard: string;
}

export interface AclEntry {
  action: AclAction;
  protocol: Protocol;
  source: AclEndpoint;
  destination: AclEndpoint;
  port?: number | null;
}

export interface AclList {
  name: string;
  type: "extended";
  entries: AclEntry[];
}

export interface NatRule {
  aclName: string;
  interface: string;
  overload: boolean;
}

export interface NatTranslation {
  protocol: Protocol;
  insideLocal: string;
  insideGlobal: string;
  outsideLocal: string;
  outsideGlobal: string;
  patPort: number;
  egressInterface: string;
  createdAt: string;
  lastUsedAt: string;
}

export interface CliState {
  mode: CliMode;
  currentInterface: string | null;
  currentDhcpPool: string | null;
  currentAcl: string | null;
  currentRouting: string | null;
  currentClassMap: string | null;
  currentPolicyMap: string | null;
  currentPolicyClass: string | null;
  history: string[];
  historyCursor: number | null;
  historyDraft: string;
  terminalLines: string[];
  commandDraft: string;
}

export interface DynamicNetwork {
  network: string;
  wildcard: string;
}

export interface DynamicRoutingProcess {
  protocol: RoutingProtocol;
  processId: string;
  networks: DynamicNetwork[];
  version?: number;
  noAutoSummary?: boolean;
  passiveInterfaces?: string[];
}

export interface QosClassMap {
  name: string;
  matchType: "all" | "any";
  matches: string[];
}

export interface QosPolicyClass {
  className: string;
  priorityPercent?: number;
  bandwidthPercent?: number;
  dscp?: string;
}

export interface QosPolicyMap {
  name: string;
  classes: QosPolicyClass[];
}

export interface MailMessage {
  from: string;
  to: string;
  body: string;
  receivedAt: string;
}

export interface Device {
  id: string;
  name: string;
  type: DeviceType;
  x: number;
  y: number;
  interfaces: NetworkInterface[];
  gateway: string;
  dns: string;
  services: {
    dhcp: boolean;
    dns: boolean;
    http: boolean;
    mail: boolean;
  };
  dnsRecords: Record<string, string>;
  httpContent: string;
  mailboxes: Record<string, MailMessage[]>;
  dhcpExcluded: IpRange[];
  dhcpPools: DhcpPool[];
  dhcpBindings: DhcpBinding[];
  staticRoutes: StaticRoute[];
  dynamicRouting: DynamicRoutingProcess[];
  acls: Record<string, AclList>;
  nat: {
    overloadRules: NatRule[];
    translations: NatTranslation[];
    nextPort: number;
  };
  qos: {
    enabled: boolean;
    trust: string;
    classMaps: Record<string, QosClassMap>;
    policyMaps: Record<string, QosPolicyMap>;
  };
  cli: CliState;
}

export interface Link {
  id: string;
  from: string;
  to: string;
  fromIf: string;
  toIf: string;
}

export type ScenarioDeviceSeed =
  Partial<Omit<Device, "interfaces" | "acls" | "services">>
  & Pick<Device, "id" | "name" | "type" | "x" | "y">
  & {
    interfaces?: Array<Partial<NetworkInterface> & Pick<NetworkInterface, "name">>;
    acls?: Record<string, AclList | AclEntry[]>;
    services?: Partial<Device["services"]>;
  };

export interface Scenario {
  id: string;
  name: string;
  difficulty: string;
  objectives: string[];
  why: string;
  devices: ScenarioDeviceSeed[];
  links: Link[];
}

export interface FlowState {
  id: string;
  mode: string;
  sourceName: string;
  target: string;
  success: boolean;
  pathDevices: string[];
  pathLinks: string[];
  reasons: string[];
  steps: FlowStep[];
}

export type FlowStepKind = "source" | "gateway" | "switch" | "route" | "acl" | "nat" | "qos" | "destination" | "drop";

export interface FlowStep {
  kind: FlowStepKind;
  label: string;
  detail: string;
  status: "ok" | "warn" | "bad";
  deviceId?: string;
  linkId?: string;
}

export interface ProgressEntry {
  completed: boolean;
  score: number;
  lastValidatedAt: string;
}

export interface EventEntry {
  time: string;
  message: string;
  level: "info" | "success" | "warn" | "error";
}

export interface LabState {
  currentScenarioId: string;
  selectedDeviceId: string | null;
  mode: string;
  theme: "dark" | "light";
  devices: Record<string, Device>;
  links: Link[];
  events: EventEntry[];
  progress: Record<string, ProgressEntry>;
  score: number;
  terminalLines: string[];
  lastFlow: FlowState | null;
}

export interface ConnectivityResult {
  ok: boolean;
  message: string;
  reasons: string[];
  hops: string[];
  targetFound: boolean;
  forwardedOutside?: boolean;
  pathDevices: string[];
  pathLinks: string[];
  steps: FlowStep[];
}

export interface ValidationCheck {
  label: string;
  pass: boolean;
}

export interface ValidationResult {
  checks: ValidationCheck[];
  passed: number;
  total: number;
  allPassed: boolean;
}
