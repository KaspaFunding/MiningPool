// Utility functions
function formatHashrate(hashrate) {
    const units = ['H/s', 'KH/s', 'MH/s', 'GH/s', 'TH/s'];
    let value = parseFloat(hashrate);
    let unitIndex = 0;
    
    while (value >= 1000 && unitIndex < units.length - 1) {
        value /= 1000;
        unitIndex++;
    }
    
    return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function formatTime(timestamp) {
    return new Date(timestamp).toLocaleString();
}

function formatAmount(amount) {
    return (parseFloat(amount) / 1e8).toFixed(8) + ' KAS';
}

// Chart initialization
let hashrateChart;
function initChart() {
    const ctx = document.getElementById('hashrateChart').getContext('2d');
    hashrateChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [{
                label: 'Pool Hashrate',
                data: [],
                borderColor: 'rgb(59, 130, 246)',
                tension: 0.1,
                fill: false
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        callback: value => formatHashrate(value)
                    }
                },
                x: {
                    ticks: {
                        maxRotation: 45,
                        minRotation: 45
                    }
                }
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    callbacks: {
                        label: context => formatHashrate(context.raw)
                    }
                }
            }
        }
    });
}

// Update functions for each section
function updatePoolStats(stats) {
    document.getElementById('poolHashrate').textContent = formatHashrate(stats.poolHashRate);
    document.getElementById('activeMiners').textContent = stats.activeMiners;
    document.getElementById('blocksFound').textContent = stats.blocksFound;
    document.getElementById('networkHashrate').textContent = formatHashrate(stats.networkHashRate);
}

function updateHashrateChart(history) {
    hashrateChart.data.labels = history.map(point => 
        new Date(point.timestamp).toLocaleTimeString()
    );
    hashrateChart.data.datasets[0].data = history.map(point => point.hashrate);
    hashrateChart.update();
}

function updateRecentBlocks(blocks) {
    document.getElementById('recentBlocks').innerHTML = blocks.map(block => `
        <tr>
            <td class="px-6 py-4 whitespace-nowrap">${block.height}</td>
            <td class="px-6 py-4 whitespace-nowrap">${formatTime(block.timestamp)}</td>
            <td class="px-6 py-4 whitespace-nowrap">${formatAmount(block.reward)}</td>
            <td class="px-6 py-4 whitespace-nowrap">${block.miner}</td>
        </tr>
    `).join('');
}

function updateRecentPayouts(payouts) {
    document.getElementById('recentPayouts').innerHTML = payouts.map(payout => `
        <tr>
            <td class="px-6 py-4 whitespace-nowrap">${formatTime(payout.timestamp)}</td>
            <td class="px-6 py-4 whitespace-nowrap">${payout.address}</td>
            <td class="px-6 py-4 whitespace-nowrap">${formatAmount(payout.amount)}</td>
            <td class="px-6 py-4 whitespace-nowrap">${payout.txid}</td>
        </tr>
    `).join('');
}

function updateActiveMiners(miners) {
    document.getElementById('activeMinersList').innerHTML = Object.entries(miners.miners)
        .filter(([, miner]) => miner.active)
        .map(([address, miner]) => `
            <tr>
                <td class="px-6 py-4 whitespace-nowrap">${address}</td>
                <td class="px-6 py-4 whitespace-nowrap">${miner.workers}</td>
                <td class="px-6 py-4 whitespace-nowrap">${formatHashrate(miner.hashrate)}</td>
                <td class="px-6 py-4 whitespace-nowrap">${miner.shares}</td>
                <td class="px-6 py-4 whitespace-nowrap">${formatAmount(miner.balance)}</td>
                <td class="px-6 py-4 whitespace-nowrap">${miner.types.join(', ')}</td>
            </tr>
        `).join('');
}

// Error handling
function handleError(error, section) {
    console.error(`Error fetching ${section}:`, error);
    const element = document.getElementById(section);
    if (element) {
        element.innerHTML = `<tr><td colspan="4" class="px-6 py-4 text-center text-red-500">Error loading data</td></tr>`;
    }
}

// Main data fetching function
async function fetchData() {
    try {
        // Fetch pool stats
        const status = await fetch('/status').then(r => r.json());
        updatePoolStats(status);

        // Fetch hashrate history
        const hashrateHistory = await fetch('/hashrate-history').then(r => r.json());
        updateHashrateChart(hashrateHistory);

        // Fetch recent blocks
        const blocks = await fetch('/blocks').then(r => r.json());
        updateRecentBlocks(blocks);

        // Fetch recent payouts
        const payouts = await fetch('/payouts').then(r => r.json());
        updateRecentPayouts(payouts);

        // Fetch active miners
        const miners = await fetch('/miners').then(r => r.json());
        updateActiveMiners(miners);

    } catch (error) {
        console.error('Error fetching data:', error);
        handleError(error, 'recentBlocks');
        handleError(error, 'recentPayouts');
        handleError(error, 'activeMinersList');
    }
}

// Initialize and start updates
document.addEventListener('DOMContentLoaded', () => {
    initChart();
    fetchData();
    setInterval(fetchData, 10000); // Update every 10 seconds
});
