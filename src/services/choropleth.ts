export type Scale = (v: number) => string;
export function makeLinearScale(domainMin: number, domainMax: number, colors: string[]): Scale {
  const stops = colors.map(hexToRgb);
  const span = Math.max(1e-9, domainMax - domainMin);
  return (v: number) => {
    const t = Math.max(0, Math.min(1, (v - domainMin) / span));
    const p = t * (stops.length - 1);
    const i = Math.floor(p);
    const f = p - i;
    const c1 = stops[i];
    const c2 = stops[Math.min(i + 1, stops.length - 1)];
    const r = Math.round(lerp(c1[0], c2[0], f));
    const g = Math.round(lerp(c1[1], c2[1], f));
    const b = Math.round(lerp(c1[2], c2[2], f));
    return `rgb(${r},${g},${b})`;
  };
}
export function lerp(a:number,b:number,t:number){ return a + (b-a)*t; }
export function hexToRgb(hex: string): [number, number, number] {
  hex = hex.replace('#','');
  if (hex.length === 3) hex = hex.split('').map(ch => ch+ch).join('');
  const num = parseInt(hex, 16);
  return [(num>>16)&255, (num>>8)&255, num&255];
}