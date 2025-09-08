// src/services/weather.ts

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
  province?: string;
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
    // --- 第1步: 获取 Location ID ---
    const geoUrl = `https://n84nmt9v5f.re.qweatherapi.com/geo/v2/city/lookup?location=${lon.toFixed(2)},${lat.toFixed(2)}&key=${QWEATHER_KEY}`;
    console.log('[DEBUG] 正在请求 GeoAPI:', geoUrl); // <-- 调试日志
    
    const geoRes = await fetch(geoUrl);
    
    // 检查网络请求是否成功
    if (!geoRes.ok) {
      console.error(`[DEBUG] GeoAPI 网络请求失败, status: ${geoRes.status}`, geoRes);
      throw new Error(`Geo API request failed with status ${geoRes.status}`);
    }
    
    const geoData = await geoRes.json();
    console.log('[DEBUG] GeoAPI 响应数据:', JSON.parse(JSON.stringify(geoData))); // <-- 调试日志

    if (geoData.code !== '200' || !geoData.location || geoData.location.length === 0) {
      console.warn('QWeather Geo API 返回错误或无数据:', geoData);
      return null;
    }
    const locationID = geoData.location[0].id;
    const provinceName = geoData.location[0].adm1;
    const cityName = geoData.location[0].name;
    console.log(`[DEBUG] 成功获取 LocationID: ${locationID} | ${provinceName} - ${cityName}`); // <-- 调试日志

    // --- 第2步: 并行获取实时天气和3天预报 ---
    const nowUrl = `https://n84nmt9v5f.re.qweatherapi.com/v7/weather/now?location=${locationID}&key=${QWEATHER_KEY}`;
    const dailyUrl = `https://n84nmt9v5f.re.qweatherapi.com/v7/weather/3d?location=${locationID}&key=${QWEATHER_KEY}`;
    console.log(`[DEBUG] 正在请求天气数据 (Now & Daily) for ID: ${locationID}`); // <-- 调试日志

    const [nowRes, dailyRes] = await Promise.all([fetch(nowUrl), fetch(dailyUrl)]);
    
    if (!nowRes.ok || !dailyRes.ok) {
        console.error('[DEBUG] 天气API网络请求失败', { nowStatus: nowRes.status, dailyStatus: dailyRes.status });
        return null;
    }

    const nowData = await nowRes.json();
    const dailyData = await dailyRes.json();
    console.log('[DEBUG] 天气API响应数据:', { nowData: JSON.parse(JSON.stringify(nowData)), dailyData: JSON.parse(JSON.stringify(dailyData)) }); // <-- 调试日志

    if (nowData.code !== '200' || dailyData.code !== '200' || !nowData.now || !dailyData.daily) {
      console.warn('QWeather weather API 返回错误或无数据:', { nowData, dailyData });
      return null;
    }
    
    const nowResult: QWeatherNow = nowData.now;
    nowResult.province = provinceName; 
    nowResult.city = cityName;       
    
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
    try {
        const geoUrl = `https://n84nmt9v5f.re.qweatherapi.com/geo/v2/city/lookup?location=${lon.toFixed(2)},${lat.toFixed(2)}&key=${QWEATHER_KEY}`;
        console.log('[DEBUG] 正在请求 GeoAPI (用于24小时预报):', geoUrl); // <-- 调试日志
        const geoRes = await fetch(geoUrl);

        if (!geoRes.ok) {
            console.error(`[DEBUG] GeoAPI (用于24小时预报) 网络请求失败, status: ${geoRes.status}`, geoRes);
            throw new Error(`Geo API request failed with status ${geoRes.status}`);
        }
        
        const geoData = await geoRes.json();
        console.log('[DEBUG] GeoAPI 响应数据 (用于24小时预报):', JSON.parse(JSON.stringify(geoData))); // <-- 调试日志

        if (geoData.code !== '200' || !geoData.location || geoData.location.length === 0) {
            return [];
        }
        const locationID = geoData.location[0].id;

        const hourlyUrl = `https://n84nmt9v5f.re.qweatherapi.com/v7/weather/24h?location=${locationID}&key=${QWEATHER_KEY}`;
        console.log(`[DEBUG] 正在请求24小时天气数据 for ID: ${locationID}`); // <-- 调试日志
        const hourlyRes = await fetch(hourlyUrl);

        if (!hourlyRes.ok) {
            console.error(`[DEBUG] 24小时天气API网络请求失败, status: ${hourlyRes.status}`, hourlyRes);
            throw new Error(`Hourly weather API request failed with status ${hourlyRes.status}`);
        }

        const hourlyData = await hourlyRes.json();
        console.log('[DEBUG] 24小时天气API响应数据:', JSON.parse(JSON.stringify(hourlyData))); // <-- 调试日志

        if (hourlyData.code === '200' && hourlyData.hourly) {
            return hourlyData.hourly;
        }
        return [];
    } catch (err) {
        console.error(`Hourly weather fetch error for ${lon},${lat}:`, err);
        return [];
    }
}