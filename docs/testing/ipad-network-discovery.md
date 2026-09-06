# Device discovery findings — 2026-09-05, 22:10–22:15 CEST

Do not report “the iPad is not on the network” from `devicectl list devices`
alone. It lists CoreDevice's registered/discovered development devices, not
all reachable iPads.

## Observed on this Mac

- Xcode 26.6 (17F113). `devicectl` and `xcdevice` list only `pipka`, iPhone 17 Pro.
- The actual Xcode **Devices and Simulators** UI was checked with an empty
  filter: only Connected → pipka, no remembered/disconnected iPad. Its add-device
  assistant says “Choose a connected device to set up”, “USB cable”, and
  “No Devices Found”; no IP-entry option was offered there. The assistant was
  dismissed without pairing or changing another device.
- Bonjour `_companion-link._tcp` advertises **iPodnos** on Ethernet. It appeared
  and disappeared during one 12 s observation, then resolved again.
- `iPodnos.local` resolves to **192.168.1.180**. The router's reverse name is
  `ipad.localdomain`; ARP MAC was `be:6a:ea:ec:89:09` (a private address, so not
  a permanent hardware identifier).
- TCP **62078** (Apple network device communication) and advertised companion
  port 56894 accept connections. ICMP ping times out. Ping failure therefore
  does **not** establish that this device is offline.
- No `_apple-mobdev2._tcp` advertisement appeared in two 12 s observations.
  `_remotepairing._tcp` advertised only `pipka`.
- `devicectl device info details` cannot resolve `iPodnos`, the IP address, or
  candidate UDID `00008112-0011690C0AA3401E`. This UDID is registered in the
  Tram Spotter provisioning profile alongside the known iPhone; the profile
  alone does not prove a valid local pairing or identify the current LAN host.
- `idevice_id --network --list` and `idevicepair list` return no entries.
- Mac is on Ethernet 192.168.1.70/24. Wi-Fi is off; macOS application firewall
  is off. `ifconfig en0` shows link-local and private IPv6 addresses even though
  `scutil --nwi`/`networksetup -getinfo` omit usable IPv6 status. There is no
  established IPv6 fault.
- Pair-record metadata under `/var/db/lockdown` is denied by macOS privacy even
  through noninteractive sudo. No pairing keys/certificates were read, copied,
  or modified. This leaves the trust-record state unverified.

Conclusion: a device very likely to be the user's iPad is reachable on the LAN,
but is not currently exposed to the development device registry. Evidence does
not distinguish stale/missing pairing from disabled network discovery on iPad.
It does rule out declaring the whole LAN path unavailable solely from Xcode or
ping. No network/security settings or system services were changed.

## Next reconnect step

### Morning recheck — 2026-09-06, 08:12 CEST

The final delivery recheck found only `pipka` in CoreDevice. Unlike the evening
observation, `iPodnos.local` did not resolve, a three-second connection attempt
to the previously observed `192.168.1.180:62078` timed out, and a 12-second
`_companion-link._tcp` browse advertised only Mac mini and Kitchen. The old
address is historical evidence, not proof of the current DHCP address. These
checks cannot distinguish sleeping Wi-Fi, a changed address, or another
discovery interruption. Evening LAN presence was real; morning LAN discovery
was also absent. USB/Trust is still needed to validate development pairing
and a reliable subsequent wireless connection.

On this Xcode 26 installation, connect the iPad once by USB, unlock it and
accept **Trust This Computer**. Open Xcode → Window → Devices and Simulators,
select the iPad and complete preparation/Developer Mode if requested. Verify
network connection is enabled if that Xcode version exposes the control.
Disconnect USB and verify `xcrun devicectl list devices` now includes the iPad.
A pairing repair should be attempted with the device present; do not blindly
unpair all devices or reset network settings.

Keep iPad and Mac on the same Bonjour-capable LAN (not a guest-isolated SSID),
and keep the iPad powered for overnight delivery. Retain its verified UDID in
the device runbook after reconnect. A DHCP reservation can stabilize IP-based
diagnostics but cannot replace development pairing. Wireless availability is
not guaranteed while the device or Wi-Fi sleeps; USB is the reliable option
for an unattended always-available build target.

## Repeatable checks

### Afternoon recheck — 2026-09-06, 15:31–15:34 CEST

`iPodnos` again advertised `_companion-link._tcp` on Ethernet, resolved to
192.168.1.180 (and IPv6), and accepted TCP 62078. CoreDevice still listed only
the paired iPhone. Neither the historical candidate UDID nor
`devicectl manage pair --device iPodnos.local` resolved a CoreDevice device;
the latter failed before pairing. Both libimobiledevice network discovery and
its remembered-pair list were empty. The iPad is reachable on the LAN now;
the outstanding problem is development discovery/pairing, not basic reachability.
No trust records or network settings were modified.

1. `xcrun devicectl list devices` and `xcrun xcdevice list --timeout 15`.
2. Browse Bonjour for 10–15 s each (`dns-sd -B _companion-link._tcp local.`,
   `dns-sd -B _apple-mobdev2._tcp local.`, and
   `dns-sd -B _remotepairing._tcp local.`); stop each browser after collecting.
3. Resolve the observed iPad hostname; do not assume yesterday's DHCP address.
4. Test only that known device's port: `nc -z -v -G 3 ADDRESS 62078`.
5. Try the previously verified device UDID with
   `xcrun devicectl device info details --device UDID --timeout 10`.
6. If LAN is reachable but CoreDevice cannot resolve it, request USB/Trust
   repair rather than reporting “not in network”.

Primary references:
- [Apple: Troubleshoot a wireless device](https://help.apple.com/xcode/mac/current/en.lproj/devac3261a70.html)
  documents network visibility and TCP 62078. Its ping guidance must be read
  with the caveat that ICMP can be blocked independently.
- [Apple: Pair a wireless device with Xcode](https://help.apple.com/xcode/mac/current/en.lproj/devbc48d1bad.html)
  documents cable pairing, Trust, and network connection.
- [Apple: Manage devices in Device Hub](https://developer.apple.com/documentation/xcode/managing-your-simulated-and-physical-devices-in-device-hub)
  describes newer Xcode/iOS 27 wireless pairing. Do not apply its iOS 27-only
  cableless pairing instructions to this Mac's Xcode 26.6 as if available here.
