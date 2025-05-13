export async function checkDevIP() {
    try {
      const res = await fetch('https://api.ipify.org?format=json');
      const { ip } = await res.json();
      const allowed = ['24.57.218.92']; // add your dev IPs
      return allowed.includes(ip);
    } catch (err) {
      console.error('IP check failed', err);
      return false;
    }
  }
  