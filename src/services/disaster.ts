// src/services/disaster.ts
// [请替换整个文件]

const QWEATHER_KEY = import.meta.env.VITE_QWEATHER_KEY;

export interface DisasterWarning {
  title: string;
  level: string;
  type: string;
  detail: string;
}

/**
 * [修正版] 根据经纬度从和风天气获取灾害预警信息
 * @param lon 经度
 * @param lat 纬度
 * @returns 灾害预警信息数组
 */
export async function fetchDisasterWarning(lon: number, lat: number): Promise<DisasterWarning[]> {
  if (!QWEATHER_KEY) {
    console.error("VITE_QWEATHER_KEY is not configured!");
    return [];
  }
  
  const url = `https://devapi.qweather.com/v7/warning/now?location=${lon.toFixed(2)},${lat.toFixed(2)}&key=${QWEATHER_KEY}`;

  try {
    const r = await fetch(url);
    const j = await r.json();

    // [核心修改] 增加对403权限错误的处理
    if (j.code === '403') {
        console.warn('灾害预警API无权限访问。请在和风天气控制台检查您的订阅计划是否包含此项服务。');
        return [];
    }

    if (j.code === '200' && j.warning?.length > 0) {
      return j.warning.map((warn: any) => ({
        title: warn.title,
        level: warn.severity,
        type: warn.typeName,
        detail: warn.text,
      }));
    }
    return [];
  } catch (err) {
    console.error(`Disaster warning fetch error for ${lon},${lat}:`, err);
    return [];
  }
}