import { createRouter, createWebHashHistory } from 'vue-router'

const EmptyRouteView = {
  render: () => null,
}

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/dsh', name: 'dsh-home', component: EmptyRouteView },
    { path: '/dsh/session/:sessionId', name: 'dsh-session', component: EmptyRouteView },
    { path: '/dsh/native', name: 'dsh-native', component: EmptyRouteView },
    {
      path: '/',
      name: 'home',
      component: EmptyRouteView,
    },
    {
      path: '/thread/:threadId',
      name: 'thread',
      component: EmptyRouteView,
    },
    {
      path: '/skills',
      name: 'skills',
      component: EmptyRouteView,
    },
    {
      path: '/phone-agent',
      name: 'phone-agent',
      component: EmptyRouteView,
    },
    {
      path: '/automations',
      name: 'automations',
      component: EmptyRouteView,
    },
    {
      path: '/new-thread',
      redirect: { name: 'home' },
    },
    { path: '/:pathMatch(.*)*', redirect: { name: 'home' } },
  ],
})

export default router
