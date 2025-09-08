<template>
  <div class="map-wrap">
    <div class="topbar">
      <Controls v-model="ui" />
    </div>

    <div class="layer-panel">
      <label><input type="checkbox" v-model="layers.showRoute" /> 路线</label>
      <label><input type="checkbox" v-model="layers.showProvinceBorders" /> 省界</label>
      <label><input type="checkbox" v-model="layers.showProvinceFill" /> 省份填色</label>
      <label><input type="checkbox" v-model="layers.showCities" /> 沿途城市</label>
      <label><input type="checkbox" v-model="layers.showSamplePoints" /> 采样点</label>
    </div>

    <div ref="mapRef" class="map"></div>

    <Legend
      :visible="ui.showChoropleth"
      :title="legendTitle"
      :colors="legendColors"
      :minLabel="legendMin"
      :maxLabel="legendMax"
    />
  </div>
</template>


<script setup lang="ts">
import { onMounted, ref, watch, nextTick, reactive, createApp, h } from 'vue'
import Controls from './Controls.vue'
import Legend from './Legend.vue'
import { loadAmap, geocode, planDriving } from '@/services/amap'
import { fetchProvinceList, type ProvinceInfo } from '@/services/district'
import { fetchWeatherByLocation, fetchHourly24h, type QWeatherInfo } from '@/services/weather'
import { fetchDisasterWarning, type DisasterWarning } from '@/services/disaster'
import { makeLinearScale } from '@/services/choropleth'
import ProvinceInfoPopup from './ProvinceInfoPopup.vue'

const props = defineProps<{ planTrigger: { from: string; to: string; stepKm: number } | null }>()

const mapRef = ref<HTMLDivElement | null>(null)
let map: any = null
let AMapRef: any = null
let geocoder: any = null

const layers = reactive({
  showRoute: true,
  showProvinceBorders: true,
  showProvinceFill: true,
  showCities: true,
  showSamplePoints: false,
})

let provinceLayers: any[] = []
const activeProvinceAdcode = ref<string | null>(null)
let provinceInfoWindow: any | null = null;

const ui = ref({ metric: 'temp', showChoropleth: true })
const legendColors = ['#2c7bb6','#abd9e9','#ffffbf','#fdae61','#d7191c']
const legendTitle = '省级天气可视化'
const legendMin = ref('低'); const legendMax = ref('高')

let allProvinces: ProvinceInfo[] = []
let passedProvinces: ProvinceInfo[] = []
let colorByAdcode: Record<string, string> = {}
let colorValuesByAdcode: Record<string, number> = {}
let currentUnit = ''

let provinceDataCache = new Map<string, { weather: QWeatherInfo | null, warnings: DisasterWarning[] }>();

type CityInfo = { name: string; adcode: string; center?: [number, number] }
const geocodeCache = new Map<string, { province: string; provinceAdcode: string; city: string; cityAdcode: string }>()

let routePolyline: any | null = null
let sampleDots: any[] = []
let lastSamples: [number,number][] = []
let cityMarkers: any[] = []
let cityCluster: any | null = null
let lastCities: { name:string; adcode:string }[] = []

// [NEW] Array to hold the clickable province center markers
let provinceCenterMarkers: any[] = [];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function assertAmapPlugins() {
  const needed = [
    ['DistrictLayer','AMap.DistrictLayer'],
    ['DistrictSearch','AMap.DistrictSearch'],
    ['GeometryUtil','AMap.GeometryUtil'],
    ['Driving','AMap.Driving'],
    ['Geocoder','AMap.Geocoder'],
    ['MarkerClusterer', 'AMap.MarkerClusterer']
  ] as const
  const missing = needed.filter(([k]) => !AMapRef?.[k]).map(([,n]) => n)
  if (missing.length) console.warn('[AMap] Missing plugins:', missing.join(', '))
}

function normPath(path: any[]): [number,number][] {
  return path.map((p: any) => Array.isArray(p) ? [p[0], p[1]] : [p.lng, p.lat])
}

function samplePolyline(path: [number,number][], stepKm = 10): [number,number][] {
  if (!path || path.length < 2) return []
  if (!AMapRef?.GeometryUtil) {
    const out = path.filter((_, i) => i % 100 === 0)
    if (!out.includes(path[path.length-1])) out.push(path[path.length-1]);
    return out
  }

  const stepM = stepKm * 1000
  const pts: [number,number][] = [path[0]]
  let lastPoint = path[0]
  let distSinceLastSample = 0

  for (let i = 1; i < path.length; i++) {
    let p1 = lastPoint
    let p2 = path[i]
    let segDist = AMapRef.GeometryUtil.distance(p1, p2)

    while (distSinceLastSample + segDist >= stepM) {
        const remainingDist = stepM - distSinceLastSample
        const ratio = remainingDist / segDist
        const nextPoint: [number, number] = [
            p1[0] + (p2[0] - p1[0]) * ratio,
            p1[1] + (p2[1] - p1[1]) * ratio
        ]
        pts.push(nextPoint)
        
        p1 = nextPoint
        segDist -= remainingDist
        distSinceLastSample = 0
    }
    distSinceLastSample += segDist
    lastPoint = p2
  }
  pts.push(path[path.length - 1])
  return pts;
}

function ensureGeocoder() { if (!geocoder && AMapRef?.Geocoder) geocoder = new AMapRef.Geocoder({ extensions: 'all' }) }
function keyForLngLat(lnglat:[number,number]) { return `${lnglat[0].toFixed(4)},${lnglat[1].toFixed(4)}` }

async function reverseGeocodeProvinceCity(lnglat:[number,number]): Promise<{ province: string; provinceAdcode: string; city: string; cityAdcode: string } | null> {
  ensureGeocoder()
  if (!geocoder) return null
  const k = keyForLngLat(lnglat)
  if (geocodeCache.has(k)) return geocodeCache.get(k)!

  return new Promise((resolve, reject) => {
    geocoder.getAddress(lnglat, (status: string, result: any) => {
      if (status === 'complete' && result.regeocode) {
        const comp = result.regeocode.addressComponent
        const dAd: string = comp.adcode || ''
        const out = {
          province: comp.province || '',
          provinceAdcode: dAd ? dAd.slice(0,2) + '0000' : '',
          city: (Array.isArray(comp.city) ? comp.city[0] : comp.city) || comp.province || '',
          cityAdcode: dAd ? dAd.slice(0,4) + '00'   : ''
        }
        if(out.provinceAdcode) geocodeCache.set(k, out)
        resolve(out)
      } else {
        reject(new Error(`Geocoder failed with status: ${status}`))
      }
    })
  })
}

async function ensureProvinceList() {
  if (allProvinces.length) return
  allProvinces = await fetchProvinceList(AMapRef)
}

async function provincesAlongRoute(path: [number,number][]) {
  console.log("Starting to identify provinces along the route...");
  await ensureProvinceList()
  const samples = samplePolyline(path, 30)
  lastSamples = samples.slice()

  const seenAdcodes = new Set<string>()
  for (const p of samples) {
    try {
      const geoInfo = await reverseGeocodeProvinceCity(p)
      if (geoInfo?.provinceAdcode) {
        seenAdcodes.add(geoInfo.provinceAdcode)
      }
      await sleep(250);
    } catch (err) {
      console.warn(`A geocoding sample failed for point ${p}:`, err);
    }
  }

  const result = allProvinces.filter(p => seenAdcodes.has(p.adcode))
  console.log('Identified provinces:', result.map(p => p.name).join(', '));
  return result
}

async function citiesAlongRoute(path:[number,number][]) {
  const samplesCity = samplePolyline(path, 50)
  const seenAdcodes = new Set<string>()
  const out: CityInfo[] = []
  for (const p of samplesCity) {
    try {
      const g = await reverseGeocodeProvinceCity(p)
      if (g?.cityAdcode && !seenAdcodes.has(g.cityAdcode)) {
        seenAdcodes.add(g.cityAdcode)
        out.push({ name: g.city, adcode: g.adcode })
      }
       await sleep(250);
    } catch {}
  }
  return out
}

function clearProvinceLayers() {
    provinceLayers.forEach(layer => layer.setMap(null));
    provinceLayers = [];
}

function renderPassedProvinceLayers() {
    clearProvinceLayers();
    if (!AMapRef?.DistrictLayer?.Province || !passedProvinces.length) return;

    passedProvinces.forEach(province => {
        const layer = new AMapRef.DistrictLayer.Province({
            zIndex: 40,
            adcode: [province.adcode],
            depth: 0,
            styles: {
                'fill': computeFill(province.adcode),
                'province-stroke': layers.showProvinceBorders ? '#FFFFFF' : 'transparent',
                'city-stroke': 'transparent',
                'county-stroke': 'transparent'
            }
        });
        layer.setMap(map);
        
        // [MODIFIED] Removed mouseover and mouseout events from province layer
        provinceLayers.push(layer);
    });
}

// [NEW] Function to render clickable markers at the center of each province
function renderProvinceCenters() {
  provinceCenterMarkers.forEach(m => m.setMap(null));
  provinceCenterMarkers = [];

  if (!passedProvinces.length) return;

  provinceCenterMarkers = passedProvinces.map(prov => {
    const marker = new AMapRef.Marker({
      position: prov.center,
      zIndex: 90, // Ensure markers are on top
      extData: {
        adcode: prov.adcode
      }
    });

    // Add click event listener to each marker
    marker.on('click', (e: any) => {
      showProvinceInfoWindow(e.target.getPosition(), e.target.getExtData().adcode);
    });

    return marker;
  });
  
  // Add markers to the map
  map.add(provinceCenterMarkers);
}


function renderRoute(path: [number,number][], samplesForDebug: [number,number][]) {
  if (routePolyline) routePolyline.setMap(null)
  routePolyline = new AMapRef.Polyline({ path, strokeColor:'#007aff', strokeWeight:5, strokeOpacity:.9, zIndex:60 })
  if (layers.showRoute) routePolyline.setMap(map)

  sampleDots.forEach(d => d.setMap(null)); sampleDots = []
  if (layers.showSamplePoints) {
    sampleDots = samplesForDebug.map(pt => new AMapRef.CircleMarker({
      center: pt, radius: 3, fillOpacity: .9, fillColor:'#ff4081', strokeOpacity:0, zIndex: 80
    }))
    sampleDots.forEach(d => d.setMap(map))
  }
}

async function getCityCenterByAdcode(adcode:string): Promise<[number,number]|null> {
    try {
        const ds = new AMapRef.DistrictSearch({ level: 'city', extensions: 'base' });
        const result = await new Promise<any>((resolve, reject) => {
            ds.search(adcode, (status: string, res: any) => {
                if (status === 'complete') resolve(res);
                else reject(new Error('DistrictSearch failed'));
            });
        });
        const d = result?.districtList?.[0];
        return d?.center ? [d.center.lng, d.center.lat] : null;
    } catch {
        return null;
    }
}

async function renderCities(cities: { name:string; adcode:string }[]) {
  cityMarkers.forEach(m => m.setMap(null)); cityMarkers = []
  if (cityCluster) { cityCluster.setMap(null); cityCluster = null }
  if (!layers.showCities || !cities.length) return

  const enriched = await Promise.all(cities.map(async c => ({
    ...c, center: await getCityCenterByAdcode(c.adcode)
  })))
  const usable = enriched.filter(c => c.center) as Array<{name:string;adcode:string;center:[number,number]}>

  cityMarkers = usable.map(c => new AMapRef.Marker({ position: c.center, title: c.name, extData: c, zIndex:70 }))
  if (usable.length > 12 && AMapRef?.MarkerClusterer) {
    cityCluster = new AMapRef.MarkerClusterer(map, cityMarkers, { gridSize: 60 });
  } else {
    cityMarkers.forEach(m => m.setMap(map))
  }

  cityMarkers.forEach(m => m.on('click', async () => {
    const c = m.getExtData();
    const [lng, lat] = c.center;
    const nowWeather = await fetchWeatherByLocation(lng, lat);
    const hourlyWeather = await fetchHourly24h(lng, lat);

    const html = `<div id="city-popup" style="width:360px;padding:6px 6px 0 6px;">
        <div style="font-size:12px;margin-bottom:6px;">
          <b>${c.name}</b> ｜ 现在：${nowWeather?.now.temp ?? '-'}°C，${nowWeather?.now.text ?? ''}
        </div>
        <div id="chart24h" style="width:348px;height:220px;"></div>
      </div>`;
    const info = new AMapRef.InfoWindow({ content: html, offset: new AMapRef.Pixel(0, -20) });
    info.open(map, c.center);

    setTimeout(async () => {
      const el = document.getElementById('chart24h');
      if (!el || !hourlyWeather.length) return;

      const times = hourlyWeather.map(h => new Date(h.fxTime).getHours() + ':00');
      const temps = hourlyWeather.map(h => parseFloat(h.temp));
      const precips = hourlyWeather.map(h => parseFloat(h.precip));
      const winds = hourlyWeather.map(h => parseInt(h.windScale.split('-')[0]));

      try {
        const echarts: any = await import('echarts');
        const chart = echarts.init(el);
        chart.setOption({
          grid: { left: 40, right: 30, top: 35, bottom: 35 },
          tooltip: { trigger: 'axis' },
          legend: { data: ['温度(°C)','风力(级)','降水(mm)'], top: 0, left: 'center', itemGap: 10 },
          xAxis: { type: 'category', data: times },
          yAxis: [
            { type: 'value', name: '°C', min: Math.floor(Math.min(...temps) - 2), max: Math.ceil(Math.max(...temps) + 2) },
            { type: 'value', name: '级', splitLine: { show: false } },
            { type: 'value', name: 'mm', show: false, splitLine: { show: false } }
          ],
          series: [
            { name: '温度(°C)', type: 'line', smooth: true, yAxisIndex: 0, data: temps },
            { name: '风力(级)', type: 'line', smooth: true, yAxisIndex: 1, data: winds },
            { name: '降水(mm)', type: 'bar', yAxisIndex: 2, data: precips, barWidth: 6, itemStyle: { opacity: 0.6 } }
          ]
        });
      } catch (e) {
        console.warn('[ECharts] Dynamic import failed:', e)
        el.innerHTML = "图表加载失败"
      }
    }, 50);
  }))
}

function toRGBA(c: string, a = 0.7) {
  if (!c) return 'rgba(0,0,0,0.05)'
  if (c.startsWith('rgba') || c.startsWith('rgb')) return c
  const m = c.replace('#','')
  const r = parseInt(m.slice(0,2),16), g = parseInt(m.slice(2,4),16), b = parseInt(m.slice(4,6),16)
  return `rgba(${r},${g},${b},${a})`
}

async function updateWeatherColors(metric: 'temp'|'dayTemp'|'nightTemp'|'wind') {
  if (!passedProvinces.length) return;
  
  const rows: Array<{ adcode: string, value: number, unit: string }> = [];

  for (const province of passedProvinces) {
    const data = provinceDataCache.get(province.adcode);
    if (!data || !data.weather) continue;

    let value: number | null = null;
    let unit = '';

    switch (metric) {
      case 'temp':
        value = parseFloat(data.weather.now.temp);
        unit = '°C';
        break;
      case 'dayTemp':
        value = parseFloat(data.weather.daily[0]?.tempMax);
        unit = '°C';
        break;
      case 'nightTemp':
        value = parseFloat(data.weather.daily[0]?.tempMin);
        unit = '°C';
        break;
      case 'wind':
        value = parseInt(data.weather.now.windScale.split('-')[0]);
        unit = '级';
        break;
    }

    if (value !== null && !isNaN(value)) {
      rows.push({ adcode: province.adcode, value, unit });
    }
  }
    
  const values = rows.map(r => r.value).filter(v => v !== null && !isNaN(v));
  if (!values.length) return;

  const vmin = Math.min(...values), vmax = Math.max(...values);
  legendMin.value = vmin.toFixed(0); 
  legendMax.value = vmax.toFixed(0);
  const scale = makeLinearScale(vmin, vmax, legendColors);

  colorByAdcode = {}; 
  colorValuesByAdcode = {}; 
  currentUnit = rows[0]?.unit ?? '';
  rows.forEach(r => {
    colorByAdcode[r.adcode] = toRGBA(scale(r.value), 0.72);
    colorValuesByAdcode[r.adcode] = r.value;
  });
}

function computeFill(adcode: string, hover = false): string {
  const data = provinceDataCache.get(adcode);
  if (data && data.warnings.length > 0) {
    return 'rgba(220, 38, 38, 0.4)';
  }
  if (!layers.showProvinceFill) return 'transparent';
  if (hover && activeProvinceAdcode.value === adcode) return 'rgba(255,160,0,0.45)';
  if (ui.value.showChoropleth && colorByAdcode[adcode]) return colorByAdcode[adcode];
  return 'rgba(0,0,0,0.05)';
}

function showProvinceInfoWindow(lnglat: any, adcode: string) {
  const data = provinceDataCache.get(adcode);
  if (!data || !data.weather) return;

  const container = document.createElement('div');
  const app = createApp({
      render: () => h(ProvinceInfoPopup, { 
        weather: data.weather!, 
        warnings: data.warnings 
      })
  });
  app.mount(container);
  
  if (!provinceInfoWindow) {
    provinceInfoWindow = new AMapRef.InfoWindow({
      isCustom: true,
      content: container,
      offset: new AMapRef.Pixel(0, -15),
      anchor: 'bottom-center'
    });
  } else {
    provinceInfoWindow.setContent(container);
  }

  provinceInfoWindow.open(map, lnglat);
}

function clearAllDynamic() {
  if (routePolyline) { routePolyline.setMap(null); routePolyline = null; }
  sampleDots.forEach(d => d.setMap(null)); sampleDots = [];
  cityMarkers.forEach(m => m.setMap(null)); cityMarkers = [];
  // [MODIFIED] Clear the province center markers as well
  provinceCenterMarkers.forEach(m => m.setMap(null)); provinceCenterMarkers = [];
  if (cityCluster) { cityCluster.setMap(null); cityCluster = null; }
  if (provinceInfoWindow) { provinceInfoWindow.close(); }
  passedProvinces = [];
  colorByAdcode = {};
  colorValuesByAdcode = {};
  clearProvinceLayers();
}

async function doPlan(p: { from: string; to: string; stepKm: number }) {
  if (!map) return;
  clearAllDynamic();

  try {
    const [from, to] = await Promise.all([geocode(p.from), geocode(p.to)]);
    if (!from || !to) {
      alert("无法解析起终点坐标");
      return;
    }

    const res = await planDriving(map, from, to);
    const path = res.path;

    const samplesForDebug = samplePolyline(path, p.stepKm);
    renderRoute(path, samplesForDebug);
    if(routePolyline) {
        map.setFitView([routePolyline], false, [60,60,60,60], 10);
    }

    const [provincesResult, citiesResult] = await Promise.all([
      provincesAlongRoute(path),
      citiesAlongRoute(path)
    ]);

    passedProvinces = provincesResult;
    lastCities = citiesResult;
    renderCities(citiesResult);
    
    for (const prov of passedProvinces) {
      const [lon, lat] = prov.center;
      const [weather, warnings] = await Promise.all([
        fetchWeatherByLocation(lon, lat),
        fetchDisasterWarning(lon, lat)
      ]);
      provinceDataCache.set(prov.adcode, { weather, warnings });
      await sleep(300); 
    }

    if (passedProvinces.length > 0 && ui.value.showChoropleth) {
      await updateWeatherColors(ui.value.metric as any)
    }

    renderPassedProvinceLayers();
    // [MODIFIED] Call the new function to render markers
    renderProvinceCenters();

  } catch (err) {
    console.error("Driving plan failed:", err);
    alert('路线规划失败，请检查起终点坐标或网络连接');
  }
}

onMounted(async () => {
  await nextTick()
  try {
    AMapRef = await loadAmap(import.meta.env.VITE_AMAP_KEY as string);
  } catch (e) {
    console.error("高德地图JS API加载失败:", e);
    alert("高德地图JS API加载失败，请检查网络连接或API Key配置。");
    return;
  }
  
  if (!mapRef.value) return console.error('[Map] container not mounted');
  map = new AMapRef.Map(mapRef.value, { zoom: 5, center: [105, 35] })

  assertAmapPlugins()
  ensureGeocoder()
})

watch(() => props.planTrigger, (v) => { if (v) doPlan(v) }, { deep: true })

watch(ui, async (v) => {
  if (!map || !passedProvinces.length) return
  if (v.showChoropleth) {
    await updateWeatherColors(v.metric as any);
    renderPassedProvinceLayers();
  } else {
    colorByAdcode = {}; 
    renderPassedProvinceLayers();
  }
}, { deep: true })

watch(() => [layers.showProvinceFill, layers.showProvinceBorders], () => {
    renderPassedProvinceLayers();
})

watch(() => layers.showRoute, (visible) => {
  if (routePolyline) visible ? routePolyline.show() : routePolyline.hide();
})

watch(() => layers.showCities, (visible) => {
    cityMarkers.forEach(m => visible ? m.show() : m.hide());
    if (cityCluster) {
      if (visible) {
        cityCluster.setMap(map);
      } else {
        cityCluster.setMap(null);
      }
    }
})

watch(() => layers.showSamplePoints, () => {
  sampleDots.forEach(d => d.setMap(null)); sampleDots = []
  if (layers.showSamplePoints && lastSamples.length) {
    sampleDots = lastSamples.map(p =>
      new AMapRef.CircleMarker({ center:p, radius:3, strokeWeight:0, fillColor:'#111', fillOpacity:.8, zIndex:65 })
    )
    sampleDots.forEach(d => d.setMap(map))
  }
})
</script>

<style scoped>
.map-wrap {
  position: relative;
  height: calc(100vh - 180px);
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 6px 24px rgba(0,0,0,0.06);
  background: #fff;
}
.map { position: absolute; inset: 0; }
.topbar { position: absolute; top: 10px; left: 10px; z-index: 1000; }

.layer-panel {
  position: absolute; right: 10px; top: 10px; z-index: 1100;
  background: #fff; border: 1px solid #e5e7eb; border-radius: 10px;
  padding: 8px 10px; box-shadow: 0 6px 24px rgba(0,0,0,.08); font-size: 12px;
}
.layer-panel label { display: block; line-height: 20px; white-space: nowrap; }

.map-wrap :deep(.amap-info-content) {
  padding: 0;
  background: transparent;
  box-shadow: none;
  border: none;
}
.map-wrap :deep(.amap-info-close) {
  display: none;
}
.map-wrap :deep(.amap-info-outer, .amap-info-contentContainer) {
    background: transparent;
}
.map-wrap :deep(.amap-info-sharp) {
    display: none;
}

</style>