export type SimpleWeather = { tempC?: number; windKph?: number; precipNext6h?: number; text: string };

export async function fetchWeatherForCoord(lat: number, lon: number): Promise<SimpleWeather> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=precipitation&forecast_days=1`;
  const r = await fetch(url);
  const j = await r.json();
  const cw = j.current_weather || {};
  let precipNext6h: number | undefined = undefined;
  try {
    const times: string[] = j.hourly?.time || [];
    const precs: number[] = j.hourly?.precipitation || [];
    const now = new Date();
    let sum=0, cnt=0;
    for (let i=0; i<times.length; i++) {
      const t = new Date(times[i]);
      if (t >= now && cnt < 6) { sum += precs[i]; cnt++; }
    }
    if (cnt>0) precipNext6h = sum/cnt;
  } catch {}
  const text = `气温 ${cw.temperature ?? "-"}°C · 风 ${cw.windspeed ?? "-"} km/h` + (precipNext6h!=null ? ` · 未来6h降水${precipNext6h.toFixed(1)}mm/h` : "");
  return { tempC: cw.temperature, windKph: cw.windspeed, precipNext6h, text };
}

export type HourlySeries = { times: string[]; temperature: number[]; wind: number[]; precipitation: number[] };

export async function fetchHourly24h(lat: number, lon: number): Promise<HourlySeries> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,precipitation,wind_speed_10m&forecast_days=2`;
  const r = await fetch(url);
  const j = await r.json();
  const times: string[] = j.hourly?.time || [];
  const temp: number[] = j.hourly?.temperature_2m || [];
  const prec: number[] = j.hourly?.precipitation || [];
  const wind: number[] = j.hourly?.wind_speed_10m || [];

  const now = new Date();
  const outTimes: string[] = [];
  const outTemp: number[] = [];
  const outPrec: number[] = [];
  const outWind: number[] = [];

  for (let i=0; i<times.length; i++) {
    const t = new Date(times[i]);
    if (t >= now && outTimes.length < 24) {
      outTimes.push(times[i]);
      outTemp.push(temp[i]);
      outPrec.push(prec[i]);
      outWind.push(wind[i]);
    }
    if (outTimes.length >= 24) break;
  }
  return { times: outTimes, temperature: outTemp, precipitation: outPrec, wind: outWind };
}