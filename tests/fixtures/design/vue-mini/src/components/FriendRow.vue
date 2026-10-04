<script setup>
defineProps({ name: String });
</script>

<template>
  <li class="friend">
    <span class="name">{{ name }}</span>
  </li>
</template>

<style scoped>
.friend { padding: 8px; border-radius: 12px; background: #ffffff; }
.name { font-weight: 600; }
</style>
