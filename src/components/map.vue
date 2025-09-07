<template>
  <div class="map-wrap">
    <div class="topbar">
      <Controls v-model="ui" />
    </div>

    <!-- Layer manager -->
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
import { onMounted, ref, watch, nextTick, reactive } from 'vue'
import Controls from './Controls.vue'
import Legend from './Legend.vue'
import { loadAmap, planDriving } from '@/services/amap'
import { fetchProvinceList, type ProvinceInfo } from '@/services/district'
import { fetchWeatherForCoord, fetchHourly24h } from '@/services/weather'
import { makeLinearScale } from '@/services/choropleth'

const props = defineProps<{ planTrigger: { from: string; to: string; stepKm: number } | null }>()

/* ------------------------------- Map refs -------------------------------- */
const mapRef = ref<HTMLDivElement | null>(null)
let map: any = null
let AMapRef: any = null
let geocoder: any = null

/* ------------------------------ Layer toggles ----------------------------- */
const layers = reactive({
  showRoute: true,
  showProvinceBorders: true,
  showProvinceFill: true,
  showCities: true,
  showSamplePoints: false,
})

/* --------------------------- Admin rendering ------------------------------ */
let provinceLayer: any = null
const activeProvinceAdcode = ref<string | null>(null)
let hoverInfo: any = null

/* ------------------------------ UI / legend ------------------------------ */
const ui = ref({ metric: 'temp', showChoropleth: true })
const legendColors = ['#2c7bb6','#abd9e9','#ffffbf','#fdae61','#d7191c']
const legendTitle = '省级天气可视化'
const legendMin = ref('低'); const legendMax = ref('高')

/* ---------------------------- Data / caches ------------------------------ */
let allProvinces: ProvinceInfo[] = []
let passedProvinces: ProvinceInfo[] = []
let colorByAdcode: Record<string, string> = {}
let colorValuesByAdcode: Record<string, number> = {}
let currentUnit = ''

type CityInfo = { name: string; adcode: string; center?: [number, number] }
const geocodeCache = new Map<string, { province: string; provinceAdcode: string; city: string; cityAdcode: string }>()

/* --------------------- Route / sample / cities layers --------------------- */
let routePolyline: any | null = null
let sampleDots: any[] = []
let lastSamples: [number,number][] = []
let cityMarkers: any[] = []
let cityCluster: any | null = null
let lastCities: { name:string; adcode:string }[] = []


/* -------------------------------- Helpers -------------------------------- */

/** 延迟函数，用于请求节流 */
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

function parseCoord(s: string): [number, number] | null {
  const m = s.split(',').map(v => parseFloat(v.trim()))
  return m.length === 2 && m.every(x => !Number.isNaN(x)) ? [m[0], m[1]] : null
}

function normPath(path: any[]): [number,number][] {
  return path.map((p: any) => Array.isArray(p) ? [p[0], p[1]] : [p.lng, p.lat])
}

function samplePolyline(path: [number,number][], stepKm = 20): [number,number][] {
  if (!path || path.length < 2) return []
  if (!AMapRef?.GeometryUtil) {
    console.warn('[AMap] GeometryUtil not loaded, sampling will be inaccurate.')
    const out = path.filter((_, i) => i % 100 === 0) // Fallback to simple sampling
    if (!out.includes(path[path.length-1])) out.push(path[path.length-1]);
    return out
  }
  const stepM = stepKm * 1000
  const pts: [number,number][] = [path[0]]
  let dist = 0
  for (let i = 0; i < path.length - 1; i++) {
    const p1 = path[i];
    const p2 = path[i+1];
    const segDist = AMapRef.GeometryUtil.distance(p1, p2);
    while (dist + stepM < segDist) {
      dist += stepM
      const t = dist / segDist
      pts.push([p1[0] + (p2[0]-p1[0])*t, p1[1] + (p2[1]-p1[1])*t])
    }
    dist -= segDist
  }
  pts.push(path[path.length - 1])
  return pts;
}

/* --------------------------- DS / Geocoder helpers ------------------------ */

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

/* ------------------------ Provinces & Cities along route ------------------------ */
async function ensureProvinceList() {
  if (allProvinces.length) return
  allProvinces = await fetchProvinceList(AMapRef)
}

async function provincesAlongRoute(path: [number,number][]) {
  console.log("Starting to identify provinces along the route...");
  await ensureProvinceList()
  const samples = samplePolyline(path, 30) // Increased step to reduce requests
  lastSamples = samples.slice()

  const seenAdcodes = new Set<string>()
  for (const p of samples) {
    try {
      const geoInfo = await reverseGeocodeProvinceCity(p)
      if (geoInfo?.provinceAdcode) {
        seenAdcodes.add(geoInfo.provinceAdcode)
      }
      await sleep(10); // Throttle requests to avoid QPS limit
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
        out.push({ name: g.city, adcode: g.cityAdcode })
      }
       await sleep(10);
    } catch {}
  }
  return out
}

/* ---------------------- DistrictLayer Rendering ------------------ */

function ensureProvinceLayer() {
  if (provinceLayer) { provinceLayer.setMap(null); provinceLayer = null }
  if (!hoverInfo && AMapRef?.InfoWindow) {
    hoverInfo = new AMapRef.InfoWindow({ isCustom:false, offset: new AMapRef.Pixel(0,-10), anchor:'bottom-center' });
  }

  if (AMapRef?.DistrictLayer?.Province) {
    provinceLayer = new AMapRef.DistrictLayer.Province({
      zIndex: 40,
      styles: {
        'fill': (props:any) => computeFill(props.adcode),
        'province-stroke': layers.showProvinceBorders ? '#e60000' : 'transparent',
        'city-stroke': 'transparent',
        'county-stroke': 'transparent'
      }
    });
    provinceLayer.setMap(map);
    provinceLayer.on('mouseover', (e: any) => {
      const adcode = e.feature?.properties?.adcode
      if (adcode) {
        activeProvinceAdcode.value = adcode;
        showHover(e.lnglat, e.feature?.properties?.name, adcode);
      }
    });
    provinceLayer.on('mouseout', () => {
      activeProvinceAdcode.value = null;
      if (hoverInfo) hoverInfo.close();
    });
  }
}

/* ---------------------------- Route & other layers ----------------------------- */

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
    const ds = new AMapRef.DistrictSearch({ level: 'city', extensions: 'base' })
    const { districtList } = await ds.search(adcode)
    const d = districtList?.[0]
    return d?.center ? [d.center.lng, d.center.lat] : null
  } catch { return null }
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
    const now = await fetchWeatherForCoord(lat, lng);
    const h = await fetchHourly24h(lat, lng);

    const html = `<div id="city-popup" style="width:360px;padding:6px 6px 0 6px;">
        <div style="font-size:12px;margin-bottom:6px;">
          <b>${c.name}</b> ｜ 现在：${now.tempC ?? '-'}°C，风 ${now.windKph ?? '-'} km/h
        </div>
        <div id="chart24h" style="width:348px;height:220px;"></div>
      </div>`;
    const info = new AMapRef.InfoWindow({ content: html, offset: new AMapRef.Pixel(0, -20) });
    info.open(map, c.center);

    setTimeout(async () => {
      const el = document.getElementById('chart24h');
      if (!el) return;
      try {
        const echarts: any = await import('echarts');
        const chart = echarts.init(el);
        chart.setOption({
          grid: { left: 40, right: 30, top: 35, bottom: 35 },
          tooltip: { trigger: 'axis' },
          legend: { data: ['温度(°C)','风速(km/h)','降水(mm)'], top: 0, left: 'center', itemGap: 10 },
          xAxis: { type: 'category', data: h.times.map(t => t.slice(11,16)) },
          yAxis: [
            { type: 'value', name: '°C', min: Math.floor(Math.min(...h.temperature) - 2), max: Math.ceil(Math.max(...h.temperature) + 2) },
            { type: 'value', name: 'km/h', splitLine: { show: false } },
            { type: 'value', name: 'mm', show: false, splitLine: { show: false } }
          ],
          series: [
            { name: '温度(°C)', type: 'line', smooth: true, yAxisIndex: 0, data: h.temperature },
            { name: '风速(km/h)', type: 'line', smooth: true, yAxisIndex: 1, data: h.wind },
            { name: '降水(mm)', type: 'bar', yAxisIndex: 2, data: h.precipitation, barWidth: 6, itemStyle: { opacity: 0.6 } }
          ]
        });
      } catch (e) {
        console.warn('[ECharts] Dynamic import failed:', e)
        el.innerHTML = "图表加载失败"
      }
    }, 50);
  }))
}

/* -------------------------- Weather & Choropleth -------------------------- */
function toRGBA(c: string, a = 0.7) {
  if (!c) return 'rgba(0,0,0,0.05)'
  if (c.startsWith('rgba') || c.startsWith('rgb')) return c
  const m = c.replace('#','')
  const r = parseInt(m.slice(0,2),16), g = parseInt(m.slice(2,4),16), b = parseInt(m.slice(4,6),16)
  return `rgba(${r},${g},${b},${a})`
}

async function updateWeatherColors(metric: 'temp'|'wind'|'precip') {
  if (!passedProvinces.length) return
  const rows: Array<{ adcode: string, value:number, unit:string }> = []

  const weatherPromises = passedProvinces.map(async p => {
    const [lng, lat] = p.center
    return fetchWeatherForCoord(lat, lng).then(w => ({ province: p, weather: w }));
  });
  
  const results = await Promise.all(weatherPromises);

  for (const { province, weather } of results) {
    const value =
      metric === 'temp'   ? (weather.tempC ?? 0) :
      metric === 'wind'   ? (weather.windKph ?? 0) :
                            (weather.precipNext6h ?? 0)
    rows.push({ adcode: province.adcode, value, unit: metric === 'temp' ? '°C' : (metric === 'wind' ? 'km/h' : 'mm') })
  }

  const values = rows.map(r => r.value).filter(v => v !== null && !isNaN(v));
  if (!values.length) return;

  const vmin = Math.min(...values), vmax = Math.max(...values)
  legendMin.value = vmin.toFixed(1); legendMax.value = vmax.toFixed(1)
  const scale = makeLinearScale(vmin, vmax, legendColors)

  colorByAdcode = {}; colorValuesByAdcode = {}; currentUnit = rows[0]?.unit ?? '';
  rows.forEach(r => { colorByAdcode[r.adcode] = toRGBA(scale(r.value), 0.72); colorValuesByAdcode[r.adcode] = r.value })

  recolorProvinceLayer()
}

function computeFill(adcode: string, hover = false): string {
  if (!layers.showProvinceFill) return 'transparent';
  if (hover && activeProvinceAdcode.value === adcode) return 'rgba(255,160,0,0.45)';
  if (ui.value.showChoropleth && colorByAdcode[adcode]) return colorByAdcode[adcode];
  return 'rgba(0,0,0,0.05)';
}

function showHover(lnglat: AMap.LngLat, name?: string, adcode?: string) {
  if (!hoverInfo) return;
  const valueTxt = adcode && colorValuesByAdcode[adcode] != null
    ? `：${colorValuesByAdcode[adcode].toFixed(1)} ${currentUnit}`
    : '';
  hoverInfo.setContent(`<div style="font-size:12px;padding:4px 6px;"><b>${name ?? ''}</b>${valueTxt}</div>`);
  hoverInfo.open(map, lnglat);
}

function recolorProvinceLayer() {
  if (provinceLayer) {
    provinceLayer.setStyles({
      'fill': (props:any) => computeFill(props.adcode, activeProvinceAdcode.value === props.adcode),
      'province-stroke': layers.showProvinceBorders ? '#e60000' : 'transparent',
    });
  }
}

/* -------------------------------- Routing --------------------------------- */
function clearAllDynamic() {
  if (routePolyline) { routePolyline.setMap(null); routePolyline = null; }
  sampleDots.forEach(d => d.setMap(null)); sampleDots = [];
  cityMarkers.forEach(m => m.setMap(null)); cityMarkers = [];
  if (cityCluster) { cityCluster.setMap(null); cityCluster = null; }
  passedProvinces = [];
  colorByAdcode = {};
  colorValuesByAdcode = {};
  recolorProvinceLayer();
}

async function doPlan(p: { from: string; to: string; stepKm: number }) {
  if (!map) return
  clearAllDynamic()

  const from = parseCoord(p.from), to = parseCoord(p.to)
  if (!from || !to) return alert("起终点请用 'lng,lat' 格式")

  try {
    const res = await planDriving(map, from as any, to as any)
    const path = normPath(res.path)

    const samplesForDebug = samplePolyline(path, p.stepKm)
    renderRoute(path, samplesForDebug)
    map.setFitView([routePolyline], false, [60,60,60,60], 10)

    const [provincesResult, citiesResult] = await Promise.all([
      provincesAlongRoute(path),
      citiesAlongRoute(path)
    ]);

    passedProvinces = provincesResult;
    lastCities = citiesResult;
    renderCities(citiesResult);
    
    if (passedProvinces.length > 0 && ui.value.showChoropleth) {
      await updateWeatherColors(ui.value.metric as any)
    }

  } catch (err) {
    console.error("Driving plan failed:", err);
    alert('路线规划失败，请检查起终点坐标或网络连接。');
  }
}

/* --------------------------------- Init ----------------------------------- */
onMounted(async () => {
  await nextTick()
  await loadAmap(import.meta.env.VITE_AMAP_KEY as string)
  AMapRef = (window as any).AMap

  if (!mapRef.value) return console.error('[Map] container not mounted');
  map = new AMapRef.Map(mapRef.value, { zoom: 5, center: [105, 35] })

  assertAmapPlugins()
  ensureGeocoder()
  ensureProvinceLayer()
})

/* ------------------------------- Watchers --------------------------------- */
watch(() => props.planTrigger, (v) => { if (v) doPlan(v) }, { deep: true })

watch(ui, async (v) => {
  if (!map || !passedProvinces.length) return
  if (v.showChoropleth) {
    await updateWeatherColors(v.metric as any)
  } else {
    colorByAdcode = {}; 
    recolorProvinceLayer() 
  }
}, { deep: true })

watch(() => [layers.showProvinceFill, layers.showProvinceBorders], () => recolorProvinceLayer())

watch(() => layers.showRoute, (visible) => {
  if (routePolyline) visible ? routePolyline.show() : routePolyline.hide();
})

watch(() => layers.showCities, (visible) => {
    cityMarkers.forEach(m => visible ? m.show() : m.hide());
    if (cityCluster) {
      visible ? cityCluster.setMap(map) : cityCluster.setMap(null);
    }
})

watch(() => layers.showSamplePoints, (show) => {
  sampleDots.forEach(d => d.setMap(null)); sampleDots = []
  if (show && lastSamples.length) {
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
</style>
