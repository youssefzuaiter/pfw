# PFW Hardware Key

Firmware for a USB-connected Arduino that answers a 32-byte challenge
with an HMAC-SHA256 signature, used from the browser via
`src/lib/hooks/use-arduino-serial.ts` (Web Serial API — Chromium-based
browsers only, requires a real user gesture to open the port picker).

**Not independently verified against real hardware in this repo's own
environment** — no Arduino toolchain or device was available to compile
and flash it here. Confirm the round-trip on real hardware before
depending on it for anything.

## Wiring / setup

1. Board: any AVR Arduino with a real hardware UART (Uno, Nano, Mega,
   Leonardo...). No special wiring beyond USB — this only uses `Serial`.
2. Arduino IDE: **Sketch → Include Library → Manage Libraries**, search
   `Crypto` (by Rhys Weatherley), install.
3. Edit `HMAC_KEY` in `pfw-hardware-key.ino` before flashing — the
   committed value is an obvious placeholder, not a real secret. The
   server side needs the identical 32 bytes to verify a response; never
   commit the real key to source control.
4. Flash via **Sketch → Upload**.
5. Confirm the device shows up as a serial port (e.g. `/dev/tty.usbmodem*`
   on macOS, `COM*` on Windows) before testing from the browser.

## Protocol

Raw binary, no framing:

| Direction | Bytes | Meaning |
|---|---|---|
| host → device | 32 | random challenge nonce (never reused) |
| device → host | 32 | `HMAC-SHA256(HMAC_KEY, challenge)` |

115200 baud, 8N1. One challenge per response — the device never sends
unsolicited bytes.

## Known limitation

The key lives as a compile-time constant in flash, readable by anyone
who reflashes or dumps the board — this firmware proves *possession of
this specific device*, not tamper-resistance against someone who has
physically opened it. A production deployment should prefer a
secure-element board (e.g. ATECC608-class) where the key never leaves
silicon, or at minimum generate the key randomly on first boot and store
it in EEPROM instead of source. Neither is built here.
