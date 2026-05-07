import type { Device, IpRange, NetworkInterface } from "../types";

export function deepClone<T>(value: T): T {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export function ipToInt(ip: string): number {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

export function intToIp(num: number): string {
  return [24, 16, 8, 0].map((shift) => String((num >>> shift) & 255)).join(".");
}

export function isValidIp(ip: unknown): boolean {
  if (typeof ip !== "string") return false;
  const parts = ip.trim().split(".");
  return parts.length === 4 && parts.every((part) => /^\d+$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

export function isValidMask(mask: unknown): boolean {
  if (typeof mask !== "string" || !isValidIp(mask)) return false;
  const int = ipToInt(mask);
  const inverse = (~int) >>> 0;
  return ((inverse + 1) & inverse) === 0;
}

export function prefixToMask(prefix: number): string {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return "";
  if (prefix === 0) return "0.0.0.0";
  return intToIp((0xffffffff << (32 - prefix)) >>> 0);
}

export function normalizeMask(mask: unknown): string {
  if (typeof mask !== "string" && typeof mask !== "number") return "";
  const value = String(mask).trim();
  if (/^\d{1,2}$/.test(value)) return prefixToMask(Number(value));
  return isValidMask(value) ? value : "";
}

export function maskToPrefix(mask: string): number {
  let value = ipToInt(mask);
  value -= (value >>> 1) & 0x55555555;
  value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
  return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export function networkAddress(ip: string, mask: string): string {
  return intToIp(ipToInt(ip) & ipToInt(mask));
}

export function ipInSubnet(ip: string, network: string, mask: string): boolean {
  const normalizedMask = normalizeMask(mask);
  if (!isValidIp(ip) || !isValidIp(network) || !normalizedMask) return false;
  return (ipToInt(ip) & ipToInt(normalizedMask)) === (ipToInt(network) & ipToInt(normalizedMask));
}

export function isPrivateIp(ip: string): boolean {
  if (!isValidIp(ip)) return false;
  const int = ipToInt(ip);
  return (
    (int >= ipToInt("10.0.0.0") && int <= ipToInt("10.255.255.255")) ||
    (int >= ipToInt("172.16.0.0") && int <= ipToInt("172.31.255.255")) ||
    (int >= ipToInt("192.168.0.0") && int <= ipToInt("192.168.255.255"))
  );
}

export function firstUsableIp(network: string, mask: string): string {
  const normalizedMask = normalizeMask(mask);
  if (!isValidIp(network) || !normalizedMask) return "";
  const netInt = ipToInt(network) & ipToInt(normalizedMask);
  return maskToPrefix(normalizedMask) >= 31 ? intToIp(netInt) : intToIp(netInt + 1);
}

export function lastUsableIp(network: string, mask: string): string {
  const wildcard = (~ipToInt(mask)) >>> 0;
  const base = ipToInt(networkAddress(network, mask));
  return intToIp((base | wildcard) - (maskToPrefix(mask) < 31 ? 1 : 0));
}

export function normalizeInterfaceName(name: string): string {
  return String(name || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace("gigabitethernet", "g")
    .replace("fastethernet", "fa")
    .replace("ethernet", "eth");
}

export function getInterface(device: Device | null | undefined, interfaceName: string): NetworkInterface | null {
  if (!device || !interfaceName) return null;
  const normalized = normalizeInterfaceName(interfaceName);
  return device.interfaces.find((iface) => normalizeInterfaceName(iface.name) === normalized) || null;
}

export function formatInterface(iface: NetworkInterface): string {
  const ip = iface.ip ? `${iface.ip}${iface.mask ? ` / ${iface.mask}` : ""}` : "unconfigured";
  return `${iface.name}: ${ip} (${iface.up ? "up" : "down"})`;
}

export function normalizeRange(range: unknown): IpRange | null {
  if (!range || typeof range !== "object") return null;
  const candidate = range as Partial<IpRange>;
  const start = candidate.start || "";
  const end = candidate.end || start;
  if (!isValidIp(start) || !isValidIp(end)) return null;
  return { start, end };
}

export function rangeContains(range: IpRange, startIp: string, endIp: string): boolean {
  return ipToInt(range.start) <= ipToInt(startIp) && ipToInt(range.end) >= ipToInt(endIp);
}
