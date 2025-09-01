export type ProvinceInfo = { name: string; adcode: string; center: [number, number]; rings?: [number, number][][] };

function toRings(boundaries: any[]): [number, number][][] {
  return (boundaries || []).map((ring: any[]) => ring.map((p: any) => [p.lng, p.lat] as [number, number]));
}

export async function fetchProvinceList(AMap: any): Promise<ProvinceInfo[]> {
  await new Promise<void>(resolve => AMap.plugin('AMap.DistrictSearch', resolve));
  const ds = new AMap.DistrictSearch({ level: 'country', subdistrict: 1, extensions: 'base' });
  const out = await new Promise<any>((res, rej) => ds.search('中国', (s: string, r: any) => s==='complete'?res(r):rej(r)));
  const list = out?.districtList?.[0]?.districtList || [];
  return list.map((p: any) => ({ name: p.name, adcode: String(p.adcode), center: [p.center?.lng, p.center?.lat] }));
}

export async function fetchProvinceBoundary(AMap: any, adcode: string): Promise<[number, number][][]> {
  const ds = new AMap.DistrictSearch({ level: 'province', subdistrict: 0, extensions: 'all' });
  const out = await new Promise<any>((res, rej) => ds.search(adcode, (s: string, r: any) => s==='complete'?res(r):rej(r)));
  const item = out?.districtList?.[0];
  return toRings(item?.boundaries || []);
}

// preload all province boundaries with concurrency limit
async function preloadAll(AMap:any, provinces: ProvinceInfo[], limit = 6): Promise<Record<string,[number,number][][]>> {
  const res: Record<string,[number,number][][]> = {};
  let i = 0;
  async function worker() {
    while (i < provinces.length) {
      const idx = i++;
      const p = provinces[idx];
      res[p.adcode] = await fetchProvinceBoundary(AMap, p.adcode);
    }
  }
  const jobs = Array.from({length:Math.min(limit, provinces.length)}, ()=>worker());
  await Promise.all(jobs);
  return res;
}

export async function provincesAlongRoute(AMap: any, path: [number, number][], allProvinces: ProvinceInfo[]) {
  const step = Math.max(1, Math.floor(path.length / 200));
  const samples: [number, number][] = [];
  for (let i=0;i<path.length;i+=step) samples.push(path[i]);

  const ringsMap = await preloadAll(AMap, allProvinces, 6);

  const hit = new Map<string, ProvinceInfo>();
  for (const pt of samples) {
    for (const prov of allProvinces) {
      if (hit.has(prov.adcode)) continue;
      const rings = ringsMap[prov.adcode];
      if (rings && AMap.GeometryUtil.isPointInPolygon(pt, rings)) {
        hit.set(prov.adcode, { ...prov, rings });
      }
    }
  }
  return Array.from(hit.values());
}