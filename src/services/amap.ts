export function loadAmap(apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).AMap) return resolve();
    const scode = (import.meta as any).env.VITE_AMAP_SECURITY?.trim();
    (window as any)._AMapSecurityConfig = scode ? { securityJsCode: scode } : undefined;
    const s = document.createElement('script');
    s.src = `https://webapi.amap.com/maps?v=2.0&key=${apiKey}&plugin=` +
            ['AMap.Geocoder','AMap.GeoJSON' ,'AMap.Driving','AMap.AutoComplete','AMap.DistrictSearch','AMap.GeometryUtil','AMap.DistrictLayer'].join(',');
    s.onload = () => resolve();
    s.onerror = (e) => reject(e);
    document.head.appendChild(s);
  });
}
export type PlanResult = { path: [number, number][]; distance: number; duration: number };
export function planDriving(map: any, origin: [number, number], dest: [number, number]): Promise<PlanResult> {
  return new Promise((resolve, reject) => {
    // @ts-ignore
    const driving = new AMap.Driving({ map, showTraffic: false });
    driving.search(origin, dest, (status: string, result: any) => {
      if (status !== 'complete' || !result?.routes?.[0]) return reject(result);
      const route = result.routes[0];
      const path: [number, number][] = [];
      route.steps.forEach((st: any) => st.path.forEach((p: any) => path.push([p.lng, p.lat])));
      resolve({ path, distance: route.distance, duration: route.time });
    });
  });
}