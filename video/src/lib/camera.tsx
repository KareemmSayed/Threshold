import React, { createContext, useContext } from 'react';
import { useVideoConfig } from 'remotion';

export type Layout = 'wide' | 'feed' | 'tall';
export const SIZES: Record<Layout, { width: number; height: number }> = {
  wide: { width: 1920, height: 1080 },
  feed: { width: 1080, height: 1350 },
  tall: { width: 1080, height: 1920 },
};

const LayoutCtx = createContext<Layout>('wide');
export const LayoutProvider = LayoutCtx.Provider;
export const useLayoutKind = () => useContext(LayoutCtx);
/** Pick a value per aspect ratio. `feed` falls back to `tall` when omitted. */
export function per<T>(l: Layout, v: { wide: T; tall: T; feed?: T }): T {
  return l === 'feed' ? (v.feed ?? v.tall) : v[l];
}

/** A camera: the content point (x, y) sits at the centre of the frame, magnified z times. */
export type Cam = { x: number; y: number; z: number };

export const camTransform = (c: Cam, W: number, H: number, depth = 1) => {
  const z = 1 + (c.z - 1) * depth;
  const fx = W / 2 + (c.x - W / 2) * depth;
  const fy = H / 2 + (c.y - H / 2) * depth;
  return `translate(${W / 2}px, ${H / 2}px) scale(${z}) translate(${-fx}px, ${-fy}px)`;
};

/** Screen position of content point p under camera c. */
export const toScreen = (c: Cam, W: number, H: number, p: { x: number; y: number }, depth = 1) => {
  const z = 1 + (c.z - 1) * depth;
  const fx = W / 2 + (c.x - W / 2) * depth;
  const fy = H / 2 + (c.y - H / 2) * depth;
  return { x: W / 2 + z * (p.x - fx), y: H / 2 + z * (p.y - fy) };
};

/** Directional blur for anything moving faster than a few pixels a frame (a 180° shutter, lightly). */
export const Blur: React.FC<{
  id: string;
  vx: number;
  vy: number;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  as?: 'div' | 'article';
  /** Marks a camera layer, so measurements can take its transform off for a moment. */
  camera?: boolean;
}> = ({ id, vx, vy, children, className, style, as: Tag = 'div', camera }) => {
  const sx = Math.min(3.5, Math.abs(vx) * 0.05);
  const sy = Math.min(3.5, Math.abs(vy) * 0.05);
  const on = sx > 0.4 || sy > 0.4;
  return (
    <>
      {on ? (
        <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
          <filter id={id} x="-10%" y="-10%" width="120%" height="120%" colorInterpolationFilters="sRGB">
            <feGaussianBlur stdDeviation={`${sx.toFixed(2)} ${sy.toFixed(2)}`} />
          </filter>
        </svg>
      ) : null}
      <Tag className={className} style={{ ...style, filter: on ? `url(#${id})` : style?.filter }} data-camera={camera ? '' : undefined}>
        {children}
      </Tag>
    </>
  );
};

/**
 * A full-frame layer under camera `cam`. `depth` < 1 moves less (parallax for backgrounds).
 * Give `prev` (the camera one frame earlier) and an `id` for motion blur on fast pans.
 */
export const Layer: React.FC<{
  cam: Cam;
  prev?: Cam;
  depth?: number;
  id?: string;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}> = ({ cam, prev, depth = 1, id, children, className, style }) => {
  const { width: W, height: H } = useVideoConfig();
  const base: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width: W,
    height: H,
    transformOrigin: '0 0',
    transform: camTransform(cam, W, H, depth),
    ...style,
  };
  if (!prev || !id)
    return (
      <div className={className} style={base} data-camera="">
        {children}
      </div>
    );
  const a = toScreen(cam, W, H, { x: cam.x, y: cam.y }, depth);
  const b = toScreen(prev, W, H, { x: cam.x, y: cam.y }, depth);
  return (
    <Blur id={id} vx={a.x - b.x} vy={a.y - b.y} className={className} style={base} camera>
      {children}
    </Blur>
  );
};
