<template>
  <main class="screen">
    <header class="topbar">
      <h1 class="title">Chats</h1>
      <img id="me" class="me" src="/me.svg" alt="Me">
    </header>
    <router-view />
  </main>
</template>

<style>
.me { position: absolute; top: 12px; right: 16px; width: 40px; height: 40px; border-radius: 50%; }
</style>
