<template>
  <div class="controls">
    <div class="row">
      <label>可视化指标</label>
      <select v-model="metric">
        <option value="temp">温度 (°C)</option>
        <option value="wind">风速 (km/h)</option>
        <option value="precip">未来6小时平均降水 (mm/h)</option>
      </select>
    </div>
    <div class="row"><label><input type="checkbox" v-model="showChoro" /> 按省着色</label></div>
  </div>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue'
const props = defineProps<{ modelValue: { metric: string; showChoropleth: boolean } }>()
const emit = defineEmits<{ (e:'update:modelValue', v:{metric:string; showChoropleth:boolean}): void }>()
const metric = ref(props.modelValue.metric)
const showChoro = ref(props.modelValue.showChoropleth)
watch([metric, showChoro], () => emit('update:modelValue', { metric: metric.value, showChoropleth: showChoro.value }))
</script>
<style scoped>
.controls { display:flex; gap:16px; align-items:center; padding:10px 12px; background:#fff; border:1px solid #eee; border-radius:12px; box-shadow:0 4px 16px rgba(0,0,0,0.04); }
.row { display:flex; align-items:center; gap:8px; }
select { padding:6px 10px; border:1px solid #ddd; border-radius:10px; }
</style>