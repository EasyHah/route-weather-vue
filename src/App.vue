<template>
  <div class="page">
    <h1>路线规划 + 省份天气标注</h1>
    <RouteForm @plan="onPlan" />
    <MapView :planTrigger="planTrigger" />
  </div>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import RouteForm from './components/RouteForm.vue'
import MapView from './components/MapView.vue'
const planTrigger = ref<{ from:string; to:string; stepKm:number } | null>(null)
function onPlan(p:{from:string;to:string;stepKm:number}){ planTrigger.value = p }
</script>
<style>
:root{ color-scheme: light; }
*{ box-sizing: border-box; }
body,html,#app{ margin:0; height:100%; }
.page{ padding: 16px; background:#f5f7fa; color:#111; font-family: ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC"; }
h1{ font-size:18px; margin:8px 0 12px; font-weight:700; }
</style>