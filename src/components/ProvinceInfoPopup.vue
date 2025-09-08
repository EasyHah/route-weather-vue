<template>
  <div class="popup-card">
    <h4>
      <span class="location-icon">📍</span>
      {{ weather.now.province }}
      <span v-if="weather.now.city && weather.now.city !== weather.now.province" class="city-name">
        - {{ weather.now.city }}
      </span>
    </h4>

    <div v-if="warnings && warnings.length > 0" class="warnings">
      <div v-for="(warn, i) in warnings" :key="i" :class="getWarningClass(warn)">
        <strong>{{ warn.type }}{{ warn.level }}预警</strong>
      </div>
    </div>

    <table class="weather-table">
      <tbody>
        <tr>
          <td><strong>当前</strong></td>
          <td>
            <span class="weather-icon">🌡️</span> {{ weather.now.temp }}°C ({{ weather.now.text }})
          </td>
        </tr>
        <tr v-if="todayForecast">
          <td><strong>今日</strong></td>
          <td>
            <span class="weather-icon">☀️</span> {{ todayForecast.textDay }} / {{ todayForecast.textNight }}
          </td>
        </tr>
        <tr v-if="todayForecast">
          <td><strong>气温</strong></td>
           <td>
            <span class="weather-icon">↕️</span> {{ todayForecast.tempMin }}°C ~ {{ todayForecast.tempMax }}°C
          </td>
        </tr>
        <tr>
          <td><strong>风力</strong></td>
          <td>
            <span class="weather-icon">💨</span> {{ weather.now.windDir }} {{ weather.now.windScale }}级
          </td>
        </tr>
        <tr>
          <td><strong>湿度</strong></td>
          <td>
            <span class="weather-icon">💧</span> {{ weather.now.humidity }}%
          </td>
        </tr>
        <tr>
          <td><strong>降水</strong></td>
          <td>
            <span class="weather-icon">💧</span> {{ weather.now.precip }} mm/h
          </td>
        </tr>
      </tbody>
    </table>
    <div class="footnote">数据更新于: {{ formatTime(weather.now.obsTime) }}</div>
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

const todayForecast = computed(() => {
  return props.weather.daily && props.weather.daily.length > 0 ? props.weather.daily[0] : null;
});

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
  padding: 12px 16px;
  border-radius: 10px;
  box-shadow: 0 5px 15px rgba(0,0,0,0.2);
  width: 280px;
  font-size: 14px;
  border: 1px solid #e2e8f0;
  color: #333;
}
.popup-card h4 {
  margin: 0 0 10px 0;
  font-size: 16px;
  color: #1a202c;
  display: flex;
  align-items: center;
}
.location-icon {
  margin-right: 6px;
}
.city-name {
  color: #718096;
  margin-left: 5px;
}

.warnings {
  margin-bottom: 10px;
}
.warning-item {
  padding: 4px 8px;
  border-radius: 4px;
  font-size: 12px;
  margin-bottom: 4px;
  text-align: center;
  border: 1px solid;
}
.warning-item.blue { background-color: #e0f2fe; border-color: #7dd3fc; color: #0c4a6e; }
.warning-item.yellow { background-color: #fefce8; border-color: #fde047; color: #854d0e; }
.warning-item.orange { background-color: #fff7ed; border-color: #fb923c; color: #9a3412; }
.warning-item.red { background-color: #ffe4e6; border-color: #fda4af; color: #9f1239; }


.weather-table {
  width: 100%;
  border-collapse: collapse;
}
.weather-table td {
  padding: 6px 4px;
  border-bottom: 1px solid #f0f0f0;
  vertical-align: middle;
}
.weather-table tr:last-child td {
  border-bottom: none;
}
.weather-table td:first-child {
  color: #4a5568;
  width: 60px;
}
.weather-icon {
  display: inline-block;
  width: 20px;
}


.footnote {
  margin-top: 10px;
  text-align: right;
  font-size: 11px;
  color: #a0aec0;
}
</style>