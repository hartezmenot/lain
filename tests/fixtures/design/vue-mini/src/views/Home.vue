<script setup>
import FriendRow from '../components/FriendRow.vue';
const friends = ['Ada', 'Grace', 'Linus'];
</script>

<template>
  <ul class="friends">
    <FriendRow v-for="f in friends" :key="f" :name="f" />
  </ul>
  <router-link class="go" to="/settings">Settings</router-link>
</template>

<style>
.friends { display: flex; flex-direction: column; gap: 8px; list-style: none; margin: 0; padding: 12px 16px; }
</style>
