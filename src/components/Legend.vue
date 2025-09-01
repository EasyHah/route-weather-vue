<template>
  <div class="legend" v-if="visible">
    <div class="title">{{ title }}</div>
    <div class="bar"><div v-for="(c,i) in colors" :key="i" class="sw" :style="{ background:c }"></div></div>
    <div class="ticks"><span>{{ minLabel }}</span><span>{{ maxLabel }}</span></div>
  </div>
</template>
<script setup lang="ts">
defineProps<{ title: string; colors: string[]; minLabel: string; maxLabel: string; visible?: boolean }>()
</script>
<style scoped>
.legend { position:absolute; right:14px; bottom:14px; background:#fff; border:1px solid #eee; border-radius:12px; padding:8px 10px; box-shadow:0 4px 16px rgba(0,0,0,0.08); width:220px; }
.title { font-size:12px; color:#444; margin-bottom:6px; }
.bar { display:flex; height:14px; border-radius:8px; overflow:hidden; }
.sw { flex:1; }
.ticks { display:flex; justify-content:space-between; font-size:11px; color:#666; margin-top:4px; }
</style>