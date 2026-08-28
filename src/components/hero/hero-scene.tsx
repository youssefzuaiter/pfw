"use client";

import { Canvas, useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { ParticleField } from "./particle-field";

/**
 * On unmount, dispose the WebGL context explicitly rather than trusting
 * garbage collection alone. R3F's `<Canvas dispose>` (default `true`)
 * already walks the scene graph disposing geometries/materials/textures
 * declared as JSX, but it does not call `forceContextLoss()` — without
 * it, rapid mount/unmount cycles (route navigation, React Fast Refresh
 * in dev) can pile up real WebGL contexts before the GC ever reclaims
 * the old ones, and browsers cap the number of live contexts per page.
 */
function ContextCleanup() {
  const gl = useThree((state) => state.gl);

  useEffect(() => {
    return () => {
      gl.dispose();
      gl.forceContextLoss();
    };
  }, [gl]);

  return null;
}

export function HeroScene({ active }: { active: boolean }) {
  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 1.5]}
      gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}
      camera={{ position: [0, 0, 6], fov: 45 }}
      className="h-full w-full"
    >
      <ContextCleanup />
      <ParticleField active={active} />
    </Canvas>
  );
}
