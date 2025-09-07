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
/**
 * 需要的插件（请在 src/services/amap.ts 的 loader 中确保包含）：
 *  AMap.Driving, AMap.Geocoder, AMap.DistrictSearch, AMap.GeometryUtil,
 *  AMap.DistrictLayer, AMap.MarkerClusterer
 */
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
let provincePolygons: any[] = []                // fallback GeoJSON 多边形
const activeProvinceAdcode = ref<string | null>(null)
let provincePropsByGb = new Map<string, {name:string;adcode:string;center:[number,number]}>()
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

const boundaryCache = new Map<string, Promise<[number,number][][]>>()
const geocodeCache = new Map<string, { province: string; provinceAdcode: string; city: string; cityAdcode: string }>()

/* --------------------- Route / sample / cities layers --------------------- */
let routePolyline: any | null = null
let sampleDots: any[] = []
let lastSamples: [number,number][] = []       // toggle “采样点”时使用
let cityMarkers: any[] = []
let cityCluster: any | null = null
let lastCities: { name:string; adcode:string }[] = []

/* -------------------------------- Helpers -------------------------------- */
function assertAmapPlugins() {
  const needed = [
    ['DistrictLayer','AMap.DistrictLayer'],
    ['DistrictSearch','AMap.DistrictSearch'],
    ['GeometryUtil','AMap.GeometryUtil'],
    ['Driving','AMap.Driving'],
    ['Geocoder','AMap.Geocoder'],
  ] as const
  const missing = needed.filter(([k]) => !AMapRef?.[k])
                        .map(([,n]) => n)
  if (missing.length) console.warn('[AMap] Missing plugins (地图仍可加载，部分功能会降级):', missing.join(', '))
}

function parseCoord(s: string): [number, number] | null {
  const m = s.split(',').map(v => parseFloat(v.trim()))
  return m.length === 2 && m.every(x => !Number.isNaN(x)) ? [m[0], m[1]] : null
}
function normPath(path: any[]): [number,number][] {
  return path.map((p: any) => Array.isArray(p) ? [p[0], p[1]] : [p.lng, p.lat])
}

/** 等距采样：省(更密) / 市(更疏)分别调用 */
function samplePolyline(path: [number,number][], stepKm = 10): [number,number][] {
  if (!path || path.length < 2) return []
  if (!AMapRef?.GeometryUtil) {
    const n = Math.max(1, Math.floor(path.length / 300))
    const out = path.filter((_, i) => i % n === 0)
    if (out[out.length-1] !== path[path.length-1]) out.push(path[path.length-1])
    return out
  }
  const stepM = stepKm * 1000
  const pts: [number,number][] = []
  let carry = 0
  for (let i=0; i<path.length-1; i++) {
    const a = path[i], b = path[i+1]
    const seg = AMapRef.GeometryUtil.distance(a, b)
    let d = carry
    while (d + stepM <= seg) {
      const t = (d ? (d + stepM) : stepM) / seg
      pts.push([a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t])
      d += stepM
    }
    carry = seg - d
  }
  if (!pts.length || pts[0][0] !== path[0][0] || pts[0][1] !== path[0][1]) pts.unshift(path[0])
  const last = path[path.length-1]
  const tail = pts[pts.length-1]
  if (!tail || tail[0] !== last[0] || tail[1] !== last[1]) pts.push(last)
  return pts
}

/** Province center KNN 预筛 */
function sqDistLngLat(a:[number,number], b:[number,number]) {
  const kx = Math.cos(((a[1]+b[1])/2) * Math.PI/180) * 111320
  const ky = 110540
  const dx = (a[0]-b[0]) * kx
  const dy = (a[1]-b[1]) * ky
  return dx*dx + dy*dy
}
function kNearestProvinces(pt:[number,number], k=6): ProvinceInfo[] {
  return [...allProvinces].sort((p,q)=> sqDistLngLat(pt,p.center as any) - sqDistLngLat(pt,q.center as any)).slice(0,k)
}

/* --------------------------- DS / boundary helpers ------------------------ */
function dsSearchWithTimeout(opts: any, query: string, ms = 12000) {
  return new Promise<any>((resolve, reject) => {
    if (!AMapRef?.DistrictSearch) return resolve(null) // 降级
    const ds = new AMapRef.DistrictSearch(opts)
    const t = setTimeout(() => reject(new Error(`DistrictSearch timeout: ${JSON.stringify(opts)} ${query}`)), ms)
    ds.search(query, (status: string, res: any) => {
      clearTimeout(t)
      if (status !== 'complete') reject(new Error(`DistrictSearch failed: ${status}`))
      else resolve(res)
    })
  })
}
function closeRing(ring: [number,number][]) {
  if (!ring.length) return ring
  const [fx, fy] = ring[0]
  const [lx, ly] = ring[ring.length - 1]
  if (fx !== lx || fy !== ly) return [...ring, [fx, fy]]
  return ring
}
function pointInAnyBoundary(pt: [number,number], boundaries: [number,number][][]): boolean {
  const GU = AMapRef?.GeometryUtil
  if (!GU?.isPointInRing) return false
  for (const rawRing of boundaries) {
    const ring = closeRing(rawRing)
    if (GU.isPointInRing(pt, ring)) return true
  }
  return false
}
function getBoundaryRings(adcode: string): Promise<[number,number][][]> {
  if (boundaryCache.has(adcode)) return boundaryCache.get(adcode)!
  // 多层级尝试
  const tryLevels: Array<'province'|'city'|'district'> = ['province','city','district']

  const task = (async () => {
    if (!AMapRef?.DistrictSearch) throw new Error('DistrictSearch not available')
    let lastErr: unknown = null
    for (const lv of tryLevels) {
      try {
        const res = await dsSearchWithTimeout({ level: lv, extensions: 'all' }, adcode, 12000)
        const d = res?.districtList?.[0]
        const rings: [number,number][][] = (d?.boundaries || [])
          .map((ring: any[]) => ring.map(p => [p.lng, p.lat] as [number,number]))
        if (rings.length) return rings
        lastErr = new Error(`No boundaries for ${adcode} at level=${lv}`)
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr ?? new Error(`Failed to load boundaries for ${adcode}`)
  })()

  boundaryCache.set(adcode, task)
  return task
}

/* ----------------------------- Geocoder helpers --------------------------- */
function ensureGeocoder() { if (!geocoder && AMapRef?.Geocoder) geocoder = new AMapRef.Geocoder({ extensions: 'all' }) }
function keyForLngLat(lnglat:[number,number]) { return `${lnglat[0].toFixed(4)},${lnglat[1].toFixed(4)}` } // ~11m grid

async function reverseGeocodeProvinceCity(lnglat:[number,number]): Promise<{ province: string; provinceAdcode: string; city: string; cityAdcode: string } | null> {
  ensureGeocoder()
  if (!geocoder) return null
  const k = keyForLngLat(lnglat)
  if (geocodeCache.has(k)) return geocodeCache.get(k)!
  const res = await new Promise<any>((resolve, reject) => {
    geocoder.getAddress(lnglat, (status: string, r: any) => {
      if (status !== 'complete') reject(new Error('Geocoder failed'))
      else resolve(r)
    })
  })
  const comp = res?.regeocode?.addressComponent || {}
  const dAd: string = comp.adcode || '' // district adcode
  const provinceAd = dAd ? dAd.slice(0,2) + '0000' : ''
  const cityAd     = dAd ? dAd.slice(0,4) + '00'   : ''
  const cityNameRaw = Array.isArray(comp.city) ? (comp.city[0] || '') : (comp.city || '')
  const out = {
    province: comp.province || '',
    provinceAdcode: provinceAd,
    city: cityNameRaw || comp.province || '',
    cityAdcode: cityAd
  }
  geocodeCache.set(k, out)
  return out
}

/* ------------------------ Provinces: accurate list ------------------------ */
async function ensureProvinceList() {
  if (allProvinces.length) return allProvinces
  allProvinces = await fetchProvinceList(AMapRef)
  return allProvinces
}

async function provincesAlongRouteAccurate(path: [number,number][]) {
  await ensureProvinceList()
  const samplesProv = samplePolyline(path, 8) // dense
  lastSamples = samplesProv.slice()

  const result: ProvinceInfo[] = []
  const seen = new Set<string>()
  let lastAd: string | null = null

  for (const p of samplesProv) {
    // still inside last province?
    if (lastAd) {
      try {
        const rings = await getBoundaryRings(lastAd)
        if (pointInAnyBoundary(p, rings)) continue
      } catch {}
    }

    // polygon hit via KNN → 10 → all
    let hit: ProvinceInfo | null = null
    const candidateSets: ProvinceInfo[][] = [
      kNearestProvinces(p, 6),
      kNearestProvinces(p, 10),
      allProvinces
    ]
    for (const cand of candidateSets) {
      let found = false
      for (const prov of cand) {
        try {
          const rings = await getBoundaryRings(prov.adcode)
          if (pointInAnyBoundary(p, rings)) { hit = prov; found = true; break }
        } catch {}
      }
      if (found) break
    }

    // geocoder fallback + cross-check
    let byGeo: ProvinceInfo | null = null
    try {
      const g = await reverseGeocodeProvinceCity(p)
      if (g?.provinceAdcode) byGeo = allProvinces.find(x => x.adcode === g.provinceAdcode) || null
    } catch {}

    const finalHit = byGeo ?? hit
    if (finalHit) {
      if (finalHit.adcode !== lastAd) {
        lastAd = finalHit.adcode
        if (!seen.has(finalHit.adcode)) { seen.add(finalHit.adcode); result.push(finalHit) }
      }
    }
  }
  return result
}

/* ------------------------- Cities: efficient list ------------------------- */
async function citiesAlongRouteFast(path:[number,number][]) {
  const samplesCity = samplePolyline(path, 25)  // sparse
  const seen = new Set<string>()
  const out: CityInfo[] = []
  for (const p of samplesCity) {
    try {
      const g = await reverseGeocodeProvinceCity(p)
      if (!g?.cityAdcode || seen.has(g.cityAdcode)) continue
      seen.add(g.cityAdcode)
      out.push({ name: g.city, adcode: g.cityAdcode })
    } catch {}
  }
  return out
}

/* ---------------------- DistrictLayer.Province rendering ------------------ */
function ensureProvinceLayer() {
  // 清理旧图层
  if (provinceLayer) { provinceLayer.setMap(null); provinceLayer = null }
  provincePolygons.forEach(p => p.setMap(null)); provincePolygons = [];

  // 共享悬浮窗
  if (!hoverInfo && AMapRef?.InfoWindow) {
    hoverInfo = new AMapRef.InfoWindow({ isCustom:false, offset: new AMapRef.Pixel(0,-10), anchor:'bottom-center' });
  }

  // 优先 DistrictLayer
  try {
    if (AMapRef?.DistrictLayer?.Province) {
      provinceLayer = new AMapRef.DistrictLayer.Province({
        adcode: ['100000'],
        depth: 1,
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
        activeProvinceAdcode.value = e.feature?.properties?.adcode || null;
        showHover(e.lnglat, e.feature?.properties?.name, activeProvinceAdcode.value || undefined);
        recolorProvinceLayer();
      });
      provinceLayer.on('mouseout', () => {
        activeProvinceAdcode.value = null;
        hoverInfo?.close?.();
        recolorProvinceLayer();
      });
      return;
    }
  } catch {}

  // Fallback: /public/provinces.geojson
  renderProvinceFallbackFromGeoJSON();
}

async function renderProvinceFallbackFromGeoJSON() {
  try {
    const resp = await fetch('/provinces.geojson');
    const gj = await resp.json();
    provincePropsByGb.clear();

    for (const f of gj.features) {
      const name = f.properties?.name || '';
      const gb = String(f.properties?.gb || '');
      if (!gb || name === '境界线') continue;
      const adcode = gb.startsWith('156') ? gb.slice(3) : gb;
      const geom = f.geometry;

      const paths: any[] = [];
      if (geom.type === 'MultiPolygon') {
        for (const poly of geom.coordinates) for (const ring of poly) paths.push(ring.map(([lng,lat]:number[])=>[lng,lat]));
      } else if (geom.type === 'Polygon') {
        for (const ring of geom.coordinates) paths.push(ring.map(([lng,lat]:number[])=>[lng,lat]));
      } else continue;

      const [cx, cy] = centroidOfRings(paths[0] || []);
      provincePropsByGb.set(gb, { name, adcode, center: [cx, cy] });

      const poly = new AMapRef.Polygon({
        path: paths, zIndex: 40,
        strokeColor: layers.showProvinceBorders ? '#e60000' : 'transparent',
        strokeWeight: layers.showProvinceBorders ? 1 : 0,
        fillOpacity: layers.showProvinceFill ? 0.8 : 0,
        fillColor: computeFill(adcode)
      });
      poly.setExtData({ name, adcode, center:[cx,cy] });
      poly.setMap(map);

      poly.on('mouseover', (e:any)=>{
        activeProvinceAdcode.value = adcode;
        showHover(e.lnglat, name, adcode);
        poly.setOptions({ fillColor: computeFill(adcode, true) });
      });
      poly.on('mouseout', ()=>{
        activeProvinceAdcode.value = null;
        hoverInfo?.close?.();
        poly.setOptions({ fillColor: computeFill(adcode, false) });
      });
      provincePolygons.push(poly);
    }
  } catch (err) {
    console.error('Province fallback rendering failed:', err);
  }
}

function centroidOfRings(ring: [number,number][]): [number,number] {
  if (!ring?.length) return [105,35];
  let x=0,y=0,a=0;
  for (let i=0;i<ring.length;i++){
    const [x1,y1]=ring[i], [x2,y2]=ring[(i+1)%ring.length];
    const cross = x1*y2 - x2*y1;
    a += cross; x += (x1+x2)*cross; y += (y1+y2)*cross;
  }
  a = a || 1;
  return [x/(3*a), y/(3*a)];
}

/* ---------------------------- Route & samples ----------------------------- */
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
function clearRoute() {
  if (routePolyline) routePolyline.setMap(null)
  sampleDots.forEach(d => d.setMap(null))
  routePolyline = null; sampleDots = []
}

/* --------------------------- Cities along route --------------------------- */
async function getCityCenterByAdcode(adcode:string): Promise<[number,number]|null> {
  try {
    const res:any = await dsSearchWithTimeout({ level:'city', extensions:'base' }, adcode, 8000)
    const d = res?.districtList?.[0]
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
    // @ts-ignore
    cityCluster = new AMapRef.MarkerClusterer(map, cityMarkers)
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

    // 动态加载 ECharts，避免阻断底图
    setTimeout(async () => {
      const el = document.getElementById('chart24h');
      if (!el) return;
      try {
        const echarts: any = await import('echarts');
        const chart = echarts.init(el);
        chart.setOption({
          grid: { left: 40, right: 30, top: 25, bottom: 35 },
          tooltip: { trigger: 'axis' },
          legend: { data: ['温度(°C)','风速(km/h)','降水(mm/h)'] },
          xAxis: { type: 'category', data: h.times.map(t => t.slice(11,16)) },
          yAxis: [
            { type: 'value', name: '°C' },
            { type: 'value', name: 'km/h' },
          ],
          series: [
            { name: '温度(°C)', type: 'line', smooth: true, yAxisIndex: 0, data: h.temperature },
            { name: '风速(km/h)', type: 'line', smooth: true, yAxisIndex: 1, data: h.wind },
            { name: '降水(mm/h)', type: 'bar', yAxisIndex: 1, data: h.precipitation, barWidth: 6, opacity: 0.6 }
          ]
        });
      } catch (e) {
        console.warn('[ECharts] 动态加载失败，24h 曲线未渲染：', e)
      }
    }, 50);
  }))
}
watch(() => layers.showCities, () => {
  if (!layers.showCities) {
    cityMarkers.forEach(m => m.setMap(null))
    if (cityCluster) cityCluster.setMap(null)
  } else if (lastCities.length) {
    renderCities(lastCities)
  }
})

/* -------------------------- Weather & choropleth -------------------------- */
function toRGBA(c: string, a = 0.7) {
  if (!c) return 'rgba(0,0,0,0.05)'
  if (c.startsWith('rgba') || c.startsWith('rgb')) return c
  const m = c.replace('#','')
  const r = parseInt(m.slice(0,2),16), g = parseInt(m.slice(2,4),16), b = parseInt(m.slice(4,6),16)
  return `rgba(${r},${g},${b},${a})`
}
async function updateWeatherColors(metric: 'temp'|'wind'|'precip') {
  if (!passedProvinces.length) return
  const rows: Array<{ adcode: string, name: string, center:[number,number], value:number, unit:string }> = []
  for (const p of passedProvinces) {
    const [lng, lat] = p.center
    const w = await fetchWeatherForCoord(lat, lng)
    const value =
      metric === 'temp'  ? (w.tempC ?? 0) :
      metric === 'wind'  ? (w.windKph ?? 0) :
                           (w.precipNext6h ?? 0)
    rows.push({ adcode: p.adcode, name: p.name, center: [lng, lat], value, unit: metric === 'temp' ? '°C' : (metric === 'wind' ? 'km/h' : 'mm/h') })
  }

  const values = rows.map(r => r.value)
  const vmin = Math.min(...values), vmax = Math.max(...values)
  legendMin.value = vmin.toFixed(1); legendMax.value = vmax.toFixed(1)
  const scale = makeLinearScale(vmin, vmax, legendColors)

  colorByAdcode = {}; colorValuesByAdcode = {}; currentUnit = rows[0]?.unit ?? '';
  rows.forEach(r => { colorByAdcode[r.adcode] = toRGBA(scale(r.value), 0.72); colorValuesByAdcode[r.adcode] = r.value })

  recolorProvinceLayer()
}

function computeFill(ad: string, hover = false): string {
  if (!layers.showProvinceFill) return 'transparent';
  if (ui.value.showChoropleth && colorByAdcode[ad]) return colorByAdcode[ad];
  if (hover && activeProvinceAdcode.value === ad) return 'rgba(255,160,0,0.35)';
  if (activeProvinceAdcode.value === ad) return 'rgba(255,160,0,0.35)';
  return 'rgba(0,0,0,0.05)';
}
function showHover(lnglat: any, name?: string, adcode?: string) {
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
      'fill': (props:any) => computeFill(props.adcode),
      'province-stroke': layers.showProvinceBorders ? '#e60000' : 'transparent',
      'city-stroke': 'transparent',
      'county-stroke': 'transparent'
    });
    // 强制刷新一次，避免偶发样式不同步
    provinceLayer.setMap(null); provinceLayer.setMap(map);
    return;
  }
  // GeoJSON fallback
  provincePolygons.forEach(poly => {
    const ad = poly.getExtData()?.adcode;
    poly.setOptions({
      strokeColor: layers.showProvinceBorders ? '#e60000' : 'transparent',
      strokeWeight: layers.showProvinceBorders ? 1 : 0,
      fillOpacity: layers.showProvinceFill ? 0.8 : 0,
      fillColor: computeFill(ad)
    });
  });
}

/* -------------------------------- Routing --------------------------------- */
function clearAllDynamic() {
  clearRoute()
  cityMarkers.forEach(m => m.setMap(null)); cityMarkers = []
  if (cityCluster) cityCluster.setMap(null); cityCluster = null
}

async function doPlan(p: { from: string; to: string; stepKm: number }) {
  if (!map) return
  clearAllDynamic()

  const from = parseCoord(p.from), to = parseCoord(p.to)
  if (!from || !to) return alert("起终点请用 'lng,lat' 格式")

  const res = await planDriving(map, from as any, to as any)
  const path = normPath(res.path)

  // Draw route & debug samples
  const samplesForDebug = samplePolyline(path, 8)
  renderRoute(path, samplesForDebug)
  map.setFitView([routePolyline], true, [60,60,60,60])

  // Provinces (accurate)
  try {
    passedProvinces = await provincesAlongRouteAccurate(path)
    ensureProvinceLayer()
  } catch (err) {
    console.error('Provinces · compute failed:', err)
  }

  // Cities (fast)
  try {
    const cities: CityInfo[] = await citiesAlongRouteFast(path)
    lastCities = cities
    renderCities(cities)
  } catch (err) {
    console.error('Cities · compute failed:', err)
  }

  // Weather → color provinces
  try {
    if (ui.value.showChoropleth) await updateWeatherColors(ui.value.metric as any)
    else { colorByAdcode = {}; recolorProvinceLayer() }
  } catch (err) {
    console.error('Weather · update failed:', err)
  }
}

/* --------------------------------- Init ----------------------------------- */
onMounted(async () => {
  await nextTick()
  await loadAmap(import.meta.env.VITE_AMAP_KEY as string)
  AMapRef = (window as any).AMap

  if (!mapRef.value || !document.body.contains(mapRef.value)) throw new Error('[Map] container not mounted')
  map = new AMapRef.Map(mapRef.value, { zoom: 5, center: [105, 35] })

  assertAmapPlugins()
  geocoder = AMapRef?.Geocoder ? new AMapRef.Geocoder({ extensions: 'all' }) : null
  ensureProvinceLayer()
})

/* ------------------------------- Watchers --------------------------------- */
watch(() => ui.value, async (v) => {
  if (!map) return
  if (!passedProvinces.length) return
  if (v.showChoropleth) await updateWeatherColors(v.metric as any)
  else { colorByAdcode = {}; recolorProvinceLayer() }
}, { deep: true })

watch(() => props.planTrigger, (v) => { if (v) doPlan(v) })
watch(() => [layers.showProvinceFill, layers.showProvinceBorders], () => recolorProvinceLayer())
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
</style>
