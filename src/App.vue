<script setup lang="ts">
import { RouterView } from 'vue-router'
</script>

<template>
  <div
    class="pointer-events-none fixed top-0 left-0 right-0 z-50"
    :style="{
      height: 'env(safe-area-inset-top, 0px)',
      backgroundColor: 'var(--ev-surface)'
    }"
  />
  <RouterView />
</template>

