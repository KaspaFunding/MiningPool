async function updateStats() {
    try {
      const response = await fetch('/api/stats');
      const data = await response.json();
      
      document.getElementById('hashrate').textContent = `${(data.hashrate / 1e6).toFixed(2)} MH/s`;
      document.getElementById('miners').textContent = data.miners;
      document.getElementById('blocks').textContent = data.blocks;
    } catch (error) {
      console.error('Error fetching stats:', error);
    }
  }
  
  // Update stats immediately and every 1 seconds
  updateStats();
  setInterval(updateStats, 1000);
