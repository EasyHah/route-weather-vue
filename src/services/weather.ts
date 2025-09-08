// src/services/weather.ts
// [请替换整个文件]

const QWEATHER_KEY = import.meta.env.VITE_QWEATHER_KEY;

// --- 和风天气 API 返回数据结构定义 ---
interface QWeatherNow {
  temp: string;
  text: string;
  windDir: string;
  windScale: string;
  humidity: string;
  precip: string;
  obsTime: string;
  province?: string; // Add optional province and city
  city?: string;
}

interface QWeatherDailyForecast {
  fxDate: string;
  tempMax: string;
  tempMin: string;
  textDay: string;
  textNight: string;
  windDirDay: string;
  windScaleDay: string;
}

interface QWeatherHourlyForecast {
    fxTime: string;
    temp: string;
    text: string;
    windScale: string;
    precip: string;
}

// --- 整合后的天气信息数据结构 ---
export interface QWeatherInfo {
  now: QWeatherNow;
  daily: QWeatherDailyForecast[];
}

/**
 * [核心函数] 根据经纬度从和风天气获取天气全家桶 (实时+3天预报)
 * @param lon 经度
 * @param lat 纬度
 * @returns 格式化后的天气信息或null
 */
export async function fetchWeatherByLocation(lon: number, lat: number): Promise<QWeatherInfo | null> {
  if (!QWEATHER_KEY) {
    console.error("VITE_QWEATHER_KEY is not configured!");
    return null;
  }

  try {
    // [核心修改] 使用正确的 GeoAPI 域名: geoapi.qweather.com
    const geoUrl = `https://geoapi.qweather.com/v2/city/lookup?location=${lon.toFixed(2)},${lat.toFixed(2)}&key=${QWEATHER_KEY}`;
    const geoRes = await fetch(geoUrl);
    const geoData = await geoRes.json();
    if (geoData.code !== '200' || !geoData.location || geoData.location.length === 0) {
      console.warn('QWeather Geo API failed:', geoData);
      return null;
    }
    const locationID = geoData.location[0].id;
    const provinceName = geoData.location[0].adm1;
    const cityName = geoData.location[0].name;

    // 并行获取实时天气和3天预报
    const nowUrl = `https://devapi.qweather.com/v7/weather/now?location=${locationID}&key=${QWEATHER_KEY}`;
    const dailyUrl = `https://devapi.qweather.com/v7/weather/3d?location=${locationID}&key=${QWEATHER_KEY}`;

    const [nowRes, dailyRes] = await Promise.all([fetch(nowUrl), fetch(dailyUrl)]);
    const nowData = await nowRes.json();
    const dailyData = await dailyRes.json();

    if (nowData.code !== '200' || dailyData.code !== '200') {
      console.warn('QWeather weather API failed:', { nowData, dailyData });
      return null;
    }
    
    // 组合成我们需要的数据结构
    const nowResult: QWeatherNow = nowData.now;
    nowResult.province = provinceName; // 附加省份信息
    nowResult.city = cityName;       // 附加城市信息
    
    return {
      now: nowResult,
      daily: dailyData.daily,
    };

  } catch (err) {
    console.error(`Weather fetch error for ${lon},${lat}:`, err);
    return null;
  }
}

/**
 * [新] 获取逐小时天气预报 (用于城市图表)
 */
export async function fetchHourly24h(lon: number, lat: number): Promise<QWeatherHourlyForecast[]> {
    if (!QWEATHER_KEY) {
        return [];
    }
    const geoUrl = `https://geoapi.qweather.com/v2/city/lookup?location=${lon.toFixed(2)},${lat.toFixed(2)}&key=${QWEATHER_KEY}`;
    const geoRes = await fetch(geoUrl);
    const geoData = await geoRes.json();
    if (geoData.code !== '200' || !geoData.location || geoData.location.length === 0) {
        return [];
    }
    const locationID = geoData.location[0].id;

    const hourlyUrl = `https://devapi.qweather.com/v7/weather/24h?location=${locationID}&key=${QWEATHER_KEY}`;
    const hourlyRes = await fetch(hourlyUrl);
    const hourlyData = await hourlyRes.json();

    if (hourlyData.code === '200') {
        return hourlyData.hourly;
    }
    return [];
}