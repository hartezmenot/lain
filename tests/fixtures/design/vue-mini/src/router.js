import { createRouter, createWebHistory } from 'vue-router';
import Home from './views/Home.vue';
import Settings from './views/Settings.vue';

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'home', component: Home },
    { path: '/settings', name: 'settings', component: Settings },
  ],
});
