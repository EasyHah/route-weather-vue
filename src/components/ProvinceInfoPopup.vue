<template>
  <div class="popup-card">
    <h4>{{ weather.now.province }}</h4>
    <div v-if="warnings && warnings.length > 0" class="warnings">
      <div v-for="(warn, i) in warnings" :key="i" :class="getWarningClass(warn)">
        <strong>{{ warn.type }} {{ warn.level }}预警</strong>
      </div>
    </div>
    <table class="weather-table">
      <tbody>
        <tr>
          <td><strong>当前</strong></td>
          <td>{{ weather.now.text }} {{ weather.now.temp }}°C</td>
        </tr>
        <tr v-if="todayForecast">
          <td><strong>白天</strong></td>
          <td>{{ todayForecast.textDay }} ({{ todayForecast.tempMax }}°C)</td>
        </tr>
        <tr v-if="todayForecast">
          <td><strong>夜间</strong></td>
          <td>{{ todayForecast.textNight }} ({{ todayForecast.tempMin }}°C)</td>
        </tr>
        <tr>
          <td><strong>风力</strong></td>
          <td>{{ weather.now.windDir }} {{ weather.now.windScale }}级</td>
        </tr>
      </tbody>
    </table>
    <div class="footnote">数据来源: 和风天气, {{ formatTime(weather.now.obsTime) }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { QWeatherInfo } from '@/services/weather';
import type { DisasterWarning } from '@/services/disaster';

const props = defineProps<{
  weather: QWeatherInfo;
  warnings: DisasterWarning[];
}>();

const todayForecast = computed(() => props.weather?.daily?.[0]);

const getWarningClass = (warn: DisasterWarning) => {
  if (warn.level.includes('蓝')) return 'warning-item blue';
  if (warn.level.includes('黄')) return 'warning-item yellow';
  if (warn.level.includes('橙')) return 'warning-item orange';
  if (warn.level.includes('红')) return 'warning-item red';
  return 'warning-item';
};

const formatTime = (timeStr: string) => {
    try {
        const date = new Date(timeStr);
        return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    } catch {
        return timeStr;
    }
}
</script>

<style scoped>
.popup-card {
  background: white;
  padding: 10px 15px;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  width: 260px;
  font-size: 13px;
  border: 1px solid #ddd;
}
.popup-card h4 { margin: 0 0 8px 0; }
.weather-table { width: 100%; border-collapse: collapse; }
.weather-table td { padding: 4px 2px; border-bottom: 1px solid #f0f0f0; }
.weather-table tr:last-child td { border-bottom: none; }
.warnings { margin-bottom: 8px; }
.warning-item {
  padding: 4px 8px;
  border-radius: 4px;
  margin-bottom: 4px;
  color: #fff;
  font-weight: bold;
}
.warning-item.blue { background-color: #3b82f6; }
.warning-item.yellow { background-color: #f59e0b; }
.warning-item.orange { background-color: #f97316; }
.warning-item.red { background-color: #ef4444; }
.footnote {
    font-size: 10px;
    color: #999;
    text-align: right;
    margin-top: 8px;
}
</style>