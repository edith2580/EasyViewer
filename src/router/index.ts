import { createRouter, createWebHashHistory } from 'vue-router'
import LibraryView from '@/views/LibraryView.vue'
import ReaderView from '@/views/ReaderView.vue'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'library',
      component: LibraryView
    },
    {
      path: '/reader/:id',
      name: 'reader',
      component: ReaderView
    }
  ]
})

export default router

