// src/services/amap.ts

// --- 状态变量，用于缓存已初始化的实例 ---
let AMapInstance: any = null;
let geocoder: any = null;
let driving: any = null;

/**
 * [已修正] 核心函数：加载高德地图JSSDK
 * 1. 修正了返回类型，现在会返回加载完成的 AMap 对象。
 * 2. 增加了缓存，确保 SDK 只被加载一次。
 */
export function loadAmap(apiKey: string): Promise<any> {
  return new Promise((resolve, reject) => {
    if (AMapInstance) {
      return resolve(AMapInstance);
    }
    // @ts-ignore
    if (window.AMap) {
        // @ts-ignore
        AMapInstance = window.AMap;
        return resolve(AMapInstance);
    }

    const scode = (import.meta as any).env.VITE_AMAP_SECURITY?.trim();
    // @ts-ignore
    window._AMapSecurityConfig = scode ? { securityJsCode: scode } : undefined;
    
    const script = document.createElement('script');
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${apiKey}&plugin=` +
            [
              'AMap.Geocoder',
              'AMap.GeoJSON' ,
              'AMap.Driving',
              'AMap.AutoComplete',
              'AMap.DistrictSearch',
              'AMap.GeometryUtil',
              'AMap.DistrictLayer',
              'AMap.MarkerClusterer'
            ].join(',');
            
    script.onload = () => {
        // @ts-ignore
        AMapInstance = window.AMap;
        resolve(AMapInstance);
    };
    script.onerror = (e) => reject(e);
    document.head.appendChild(script);
  });
}

/**
 * [已修正] 地理编码服务：地址/坐标字符串 -> 经纬度
 * 1. 调用 loadAmap 时传入了 apiKey。
 * 2. 确保只创建一个 geocoder 实例。
 */
export async function geocode(addressOrCoord: string): Promise<[number, number]> {
  // 检查输入是否已经是 "lng,lat" 格式
  const parts = addressOrCoord.split(',').map(s => parseFloat(s.trim()));
  if (parts.length === 2 && !parts.some(isNaN)) {
    return [parts[0], parts[1]];
  }
  
  // 如果不是，则进行地理编码
  if (!geocoder) {
    const AMap = await loadAmap(import.meta.env.VITE_AMAP_KEY as string);
    geocoder = new AMap.Geocoder();
  }
  return new Promise((resolve, reject) => {
    geocoder.getLocation(addressOrCoord, (status: string, result: any) => {
      if (status === 'complete' && result.geocodes.length) {
        const loc = result.geocodes[0].location;
        resolve([loc.lng, loc.lat]);
      } else {
        reject(new Error(`Geocoding failed for address: ${addressOrCoord}`));
      }
    });
  });
}

/**
 * 驾车路线规划服务
 */
export type PlanResult = { path: [number, number][]; distance: number; duration: number; routes: any[] };

export async function planDriving(map: any, origin: [number, number], dest: [number, number]): Promise<PlanResult> {
    if (!driving) {
        const AMap = await loadAmap(import.meta.env.VITE_AMAP_KEY as string);
        driving = new AMap.Driving({ map, showTraffic: false, autoFitView: true });
    }
    return new Promise((resolve, reject) => {
        driving.search(origin, dest, (status: string, result: any) => {
            if (status !== 'complete' || !result?.routes?.[0]) {
                return reject(new Error(result.info || 'Driving plan query failed'));
            }
            const route = result.routes[0];
            const path: [number, number][] = [];
            route.steps.forEach((st: any) => st.path.forEach((p: any) => path.push([p.lng, p.lat])));
            resolve({ path, distance: route.distance, duration: route.time, routes: result.routes });
        });
    });
}