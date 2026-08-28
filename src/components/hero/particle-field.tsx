"use client";

import { useThree, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";

const PARTICLE_COUNT = 900;
const FIELD_INNER_RADIUS = 2.2;
const FIELD_OUTER_RADIUS = 3.6;

// CSS named colors, not hex literals — this repo's own guard test
// (tests/guards/no-untokenized-hex.test.ts) forbids hex literals outside
// globals.css, and these are only ever used if a --pfw-* token is somehow
// missing at read time (it never is; globals.css defines all three
// unconditionally on :root).
const TOKEN_FALLBACKS = {
  "--pfw-accent": "royalblue",
  "--pfw-signature": "goldenrod",
  "--pfw-positive": "seagreen",
} as const;

/** Reads a live CSS custom property off the root element — never a hardcoded hex — so the scene always matches the active theme (light/dark/system) at mount time. */
function readColorToken(name: keyof typeof TOKEN_FALLBACKS): THREE.Color {
  if (typeof window === "undefined") return new THREE.Color(TOKEN_FALLBACKS[name]);
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return new THREE.Color(value || TOKEN_FALLBACKS[name]);
}

function buildGeometry(palette: THREE.Color[]): THREE.BufferGeometry {
  const positions = new Float32Array(PARTICLE_COUNT * 3);
  const colors = new Float32Array(PARTICLE_COUNT * 3);

  for (let i = 0; i < PARTICLE_COUNT; i += 1) {
    const radius = FIELD_INNER_RADIUS + Math.random() * (FIELD_OUTER_RADIUS - FIELD_INNER_RADIUS);
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);

    positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);

    const color = palette[i % palette.length];
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

/**
 * The only piece of scene state that needs disposing beyond what R3F's
 * `dispose` prop already handles on unmount — geometry/material created
 * with `useMemo` (not JSX-declarative `<bufferGeometry>`/`<pointsMaterial>`)
 * bypass R3F's automatic disposal, so they're disposed explicitly here.
 */
export function ParticleField({ active }: { active: boolean }) {
  const pointsRef = useRef<THREE.Points>(null);
  const { invalidate } = useThree();

  const palette = useMemo(
    () => [readColorToken("--pfw-accent"), readColorToken("--pfw-signature"), readColorToken("--pfw-positive")],
    [],
  );

  const geometry = useMemo(() => buildGeometry(palette), [palette]);
  const material = useMemo(
    () =>
      new THREE.PointsMaterial({
        size: 0.045,
        vertexColors: true,
        transparent: true,
        opacity: 0.85,
        sizeAttenuation: true,
        depthWrite: false,
      }),
    [],
  );

  useEffect(() => {
    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [geometry, material]);

  // `frameloop="demand"` on the parent <Canvas> means nothing renders
  // unless something calls invalidate() — self-scheduling the next frame
  // only while `active` (in-viewport, motion allowed) is what turns this
  // into a continuous-but-gated animation instead of a busy render loop
  // that keeps spinning the GPU off-screen or with reduced motion set.
  useFrame((_state, delta) => {
    if (!active || !pointsRef.current) return;
    pointsRef.current.rotation.y += delta * 0.08;
    pointsRef.current.rotation.x += delta * 0.015;
    invalidate();
  });

  return <points ref={pointsRef} geometry={geometry} material={material} />;
}
