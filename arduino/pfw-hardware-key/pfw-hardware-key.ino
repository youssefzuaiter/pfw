// PFW hardware key — challenge/response firmware
// ---------------------------------------------------------------------
// Protocol (matches src/lib/hooks/use-arduino-serial.ts exactly):
//   host -> device : 32 raw bytes  (a fresh random nonce, never reused)
//   device -> host : 32 raw bytes  (HMAC-SHA256(HMAC_KEY, challenge))
// No framing, no line endings, no ASCII/hex encoding — raw binary both
// directions, one challenge per response, strictly request/response
// (the device never sends unsolicited bytes).
//
// Library dependency: "Crypto" by Rhys Weatherley
//   Arduino IDE: Sketch -> Include Library -> Manage Libraries -> search
//   "Crypto" (https://github.com/rweather/arduino-cryptography) -> Install.
//   Chosen over hand-rolling SHA-256 for the same reason this project
//   moved its own client-side Shamir implementation onto an audited
//   library instead of a hand-rolled one (AGENTS.md §3x) — HMAC/SHA-256
//   is exactly the kind of primitive that's easy to get subtly wrong by
//   hand and costly to get wrong at all.
//
// NOT independently verified by compiling/flashing real hardware in this
// environment (no Arduino toolchain or device available here) — stated
// plainly rather than claimed as tested, unlike every other piece of
// this codebase, which this repo's own AGENTS.md holds to a "verified
// live" standard. Flash this to real hardware and confirm the
// challenge/response round-trip before trusting it for anything.
//
// Target: any AVR board with >= 2KB SRAM and a real hardware UART
// (Uno, Nano, Mega, Leonardo...). SHA256 here is ~broadcastable on 8-bit
// AVR at these message sizes (one 32-byte block); no ESP32/ECC hardware
// assumed.

#include <Crypto.h>
#include <SHA256.h>

// ---------------------------------------------------------------------
// Provisioning: this constant is the shared secret this device and the
// server both need to already agree on out of band (see the frontend
// wiring discussion — the server holds its own copy via env, never in
// client code). A hardcoded compile-time constant is the simplest
// correct option, and the honest limitation to state plainly: anyone who
// can reflash this board can read this constant back out of the .ino
// source (or, with more effort, out of flash) — this firmware provides
// "possession of this specific physical device," not tamper-resistance
// against someone who has taken the device apart. A real deployment
// wants either the ATECC608-class secure-element boards (key never
// leaves silicon, no `Crypto` library HMAC needed at all) or at minimum
// generating this key randomly on first boot and storing it in EEPROM
// instead of source — left as a documented next step, not built here.
//
// REPLACE before flashing — do not ship this literal placeholder value.
const uint8_t HMAC_KEY[32] = {
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
  0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
  0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
};

const long BAUD_RATE = 115200;               // must match DEFAULT_BAUD_RATE in use-arduino-serial.ts
const size_t CHALLENGE_LENGTH_BYTES = 32;
const size_t RESPONSE_LENGTH_BYTES = 32;      // SHA256 output size
const unsigned long READ_TIMEOUT_MS = 5000;   // must be <= the host's timeoutMs, or the host gives up first

SHA256 sha256;

void setup() {
  Serial.begin(BAUD_RATE);
  Serial.setTimeout(READ_TIMEOUT_MS);
}

void loop() {
  uint8_t challenge[CHALLENGE_LENGTH_BYTES];

  // Blocks until either CHALLENGE_LENGTH_BYTES bytes have arrived or
  // READ_TIMEOUT_MS elapses (Serial.setTimeout() above governs this).
  size_t received = Serial.readBytes(challenge, CHALLENGE_LENGTH_BYTES);

  if (received != CHALLENGE_LENGTH_BYTES) {
    // Partial/garbled read (a genuine timeout, or the host disconnected
    // mid-write) — discard it rather than sign a truncated challenge.
    // Whatever arrives next is treated as the start of a new challenge;
    // there is no partial-buffer carry-over between loop() iterations.
    return;
  }

  uint8_t response[RESPONSE_LENGTH_BYTES];
  sha256.resetHMAC(HMAC_KEY, sizeof(HMAC_KEY));
  sha256.update(challenge, CHALLENGE_LENGTH_BYTES);
  sha256.finalizeHMAC(HMAC_KEY, sizeof(HMAC_KEY), response, sizeof(response));

  Serial.write(response, RESPONSE_LENGTH_BYTES);
  Serial.flush(); // block until the response has actually been transmitted before looping back to listen again
}
