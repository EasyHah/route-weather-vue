// 采样与“按省分段”的工具
import * as turf from "@turf/turf";

export type LngLat = [number, number];
export type ProvinceSegment = {
  province: string;
  path: LngLat[];          // 该省路段的折线
  mid: LngLat;             // 中点坐标（用于打标）
};

export async function loadProvinces(): Promise<turf.FeatureCollection> {
  const resp = await fetch("/provinces.geojson");
  return await resp.json();
}

// 对 polyline 按固定间距（米）做等距采样
export function samplePolyline(path: LngLat[], stepMeters = 50000): LngLat[] {
  if (path.length < 2) return path;
  const line = turf.lineString(path);
  const len = turf.length(line, { units: "kilometers" }) * 1000;
  const out: LngLat[] = [];
  for (let d = 0; d <= len; d += stepMeters) {
    const p = turf.along(line, d / 1000, { units: "kilometers" }).geometry.coordinates as LngLat;
    out.push(p);
  }
  // 确保包含终点
  if (out.length === 0 || out[out.length - 1].toString() !== path[path.length - 1].toString()) {
    out.push(path[path.length - 1]);
  }
  return out;
}

export function findProvinceOfPoint(
  provincesFC: turf.FeatureCollection,
  p: LngLat,
  nameProp: string = "name"
): string | null {
  const pt = turf.point(p);
  for (const f of provincesFC.features) {
    if (turf.booleanPointInPolygon(pt, f as any)) {
      const nm = (f.properties?.[nameProp] ?? f.properties?.name ?? f.properties?.NAME) as string;
      return nm || null;
    }
  }
  return null;
}

export function groupByProvince(
  provincesFC: turf.FeatureCollection,
  path: LngLat[],
  stepMeters = 50000
): ProvinceSegment[] {
  const samples = samplePolyline(path, stepMeters);
  const tagged = samples.map((p) => ({ p, province: findProvinceOfPoint(provincesFC, p) }));

  const segments: ProvinceSegment[] = [];
  let cur: { province: string | null; pts: LngLat[] } | null = null;

  for (const { p, province } of tagged) {
    if (!cur || cur.province !== province) {
      if (cur && cur.pts.length > 1 && cur.province) {
        const midIdx = Math.floor(cur.pts.length / 2);
        segments.push({ province: cur.province, path: cur.pts, mid: cur.pts[midIdx] });
      }
      cur = { province, pts: [p] };
    } else {
      cur.pts.push(p);
    }
  }
  if (cur && cur.pts.length > 1 && cur.province) {
    const midIdx = Math.floor(cur.pts.length / 2);
    segments.push({ province: cur.province, path: cur.pts, mid: cur.pts[midIdx] });
  }
  return segments;
}

