<template>
  <form class="route-form" @submit.prevent="onSubmit">
    <div><label>起点</label><input v-model="from" placeholder="116.397,39.908" /></div>
    <div><label>终点</label><input v-model="to" placeholder="121.476,31.230" /></div>
    <div><label>采样间距(公里)</label><input type="number" v-model.number="stepKm" min="5" max="200" /></div>
    <button type="submit">规划并标注天气</button>
  </form>
</template>
<script setup lang="ts">
import { ref } from 'vue'
const from = ref('116.397,39.908')
const to = ref('121.476,31.230')
const stepKm = ref(5)
const emit = defineEmits<{ (e:'plan', v:{from:string;to:string;stepKm:number}): void }>()
function onSubmit(){ emit('plan', { from: from.value, to: to.value, stepKm: stepKm.value }) }
</script>
<style scoped>
.route-form { display:grid; grid-template-columns:1fr 1fr 1fr auto; gap:8px; align-items:end; }
label { display:block; font-size:12px; color:#666; margin-bottom:2px; }
input { padding:8px 10px; border:1px solid #ddd; border-radius:10px; }
button { padding:10px 14px; border:0; background:#111; color:#fff; border-radius:12px; cursor:pointer; }
@media (max-width:900px){ .route-form{ grid-template-columns:1fr; } }
</style>