import { Hono } from 'hono'

// --- Types ---
type Bindings = {
  LINKS_KV: KVNamespace
}

type LinkData = {
  url: string
  status: 'pending' | 'active' | 'failed'
  added_at: number
  last_check?: number
  error?: string | null
}

const app = new Hono<{ Bindings: Bindings }>()

// --- Helper: Get all links from KV ---
async function getAllLinks(kv: KVNamespace): Promise<LinkData[]> {
  const links: LinkData[] = []
  let cursor: string | undefined = undefined
  while (true) {
    const list = await kv.list({ prefix: 'link:', cursor })
    for (const key of list.keys) {
      const val = await kv.get<LinkData>(key.name, 'json')
      if (val) links.push(val)
    }
    if (list.list_complete) break
    cursor = list.cursor
  }
  return links
}

// --- Helper: key from url ---
function kvKey(url: string): string {
  return `link:${url}`
}

// --- QyShare Process ---
async function processQyShare(url: string): Promise<boolean> {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), 30000)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0' },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    const token = html.match(/const token = "([^"]+)";/)?.[1]
    const fileId = html.match(/const fileId = (\d+);/)?.[1]
    const hostsMatch = html.match(/const downloadHosts = (\[.*?\]);/s)
    if (!token || !fileId || !hostsMatch) throw new Error('Invalid Page Structure')
    const hosts = JSON.parse(hostsMatch[1])
    if (hosts.length === 0) throw new Error('No Hosts Available')
    const apiUrl = `${new URL(url).origin}/api/share/download?token=${encodeURIComponent(token)}&fileId=${encodeURIComponent(fileId)}&hostId=${hosts[0].id}`
    const apiRes = await fetch(apiUrl, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: url },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (!apiRes.ok) throw new Error('API Connection Failed')
    // Consume and discard the body
    if (apiRes.body) {
      const reader = apiRes.body.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
      reader.releaseLock()
    }
    return true
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error('Timeout (Web too slow)')
    }
    throw error
  } finally {
    clearTimeout(id)
  }
}

// --- Maintenance Runner ---
async function runMaintenance(kv: KVNamespace): Promise<string> {
  const allLinks = await getAllLinks(kv)
  if (allLinks.length === 0) return 'No links to check.'

  const shuffled = allLinks.sort(() => Math.random() - 0.5)
  const BATCH_SIZE = 5
  const results: string[] = []

  for (let i = 0; i < shuffled.length; i += BATCH_SIZE) {
    const batch = shuffled.slice(i, i + BATCH_SIZE)
    const batchNum = Math.floor(i / BATCH_SIZE) + 1
    const totalBatches = Math.ceil(shuffled.length / BATCH_SIZE)
    results.push(`Processing batch ${batchNum} of ${totalBatches}`)

    await Promise.all(
      batch.map(async (linkData) => {
        const MAX_RETRIES = 3
        let success = false
        let lastError: string | null = null

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          try {
            await processQyShare(linkData.url)
            success = true
            break
          } catch (e: any) {
            lastError = e.message
            if (attempt < MAX_RETRIES) {
              await new Promise((r) => setTimeout(r, 2000))
            }
          }
        }

        const updated: LinkData = {
          ...linkData,
          last_check: Date.now(),
          status: success ? 'active' : 'failed',
          error: success ? null : `Failed after 3 attempts: ${lastError}`,
        }
        await kv.put(kvKey(linkData.url), JSON.stringify(updated))
        results.push(`${success ? '✅' : '❌'} ${linkData.url}`)
      })
    )

    // Delay between batches (except last)
    if (i + BATCH_SIZE < shuffled.length) {
      await new Promise((r) => setTimeout(r, 5000))
    }
  }

  return results.join('\n')
}

// ===================== ROUTES =====================

// --- Main Page ---
app.get('/', async (c) => {
  const links = await getAllLinks(c.env.LINKS_KV)
  const activeCount = links.filter((l) => l.status === 'active').length

  return c.html(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>QyShare Keeper (MMT)</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" />
    </head>
    <body class="bg-slate-900 text-slate-200 min-h-screen p-4 flex flex-col items-center">
        <div class="w-full max-w-5xl">
            <!-- Header -->
            <div class="flex justify-between items-center mb-6">
                <div>
                    <h1 class="text-2xl font-bold text-emerald-400"><i class="fa-solid fa-robot mr-2"></i> QyShare Smart Keeper</h1>
                    <p class="text-xs text-slate-400 mt-1">Click "Force Check" to run maintenance</p>
                </div>
                <div class="text-right">
                    <div class="text-3xl font-bold text-white">${links.length}</div>
                    <div class="text-xs text-slate-400">Total Links</div>
                </div>
            </div>
            <!-- Input -->
            <div class="bg-slate-800 p-5 rounded-xl border border-slate-700 shadow-lg mb-8">
                <label class="block text-xs font-bold text-slate-400 mb-2 uppercase">Add Links</label>
                <div class="flex gap-2">
                    <textarea id="newLinks" rows="2" class="w-full bg-slate-900 border border-slate-600 rounded p-3 text-xs text-green-300 focus:outline-none focus:border-emerald-500" placeholder="Paste links here..."></textarea>
                    <button onclick="addLinks()" class="bg-emerald-600 hover:bg-emerald-500 text-white px-6 rounded-lg font-bold text-sm whitespace-nowrap">
                        Add
                    </button>
                </div>
            </div>
            <!-- List -->
            <div class="bg-slate-800 rounded-xl overflow-hidden border border-slate-700 shadow-lg">
                <div class="px-6 py-4 border-b border-slate-700 bg-slate-800/50 flex justify-between items-center">
                    <span class="text-sm font-bold text-slate-300">Monitored Files (${activeCount} Active)</span>
                    <button onclick="runCheckNow()" id="checkBtn" class="text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1 rounded">
                        ⚡ Force Check
                    </button>
                </div>
                <div class="overflow-x-auto max-h-[600px]">
                    <table class="w-full text-left text-xs">
                        <thead class="bg-slate-900 text-slate-500 sticky top-0">
                            <tr>
                                <th class="p-4">Link URL</th>
                                <th class="p-4">Last Checked (MMT)</th>
                                <th class="p-4">Status</th>
                                <th class="p-4 text-right">Action</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-slate-700">
                            ${links.length === 0 ? '<tr><td colspan="4" class="p-8 text-center text-slate-500">Empty List</td></tr>' : ''}
                            ${links
                              .map(
                                (l) => `
                                <tr class="hover:bg-slate-700/30 transition">
                                    <td class="p-4 text-blue-300 font-mono truncate max-w-[300px]" title="${l.url}">${l.url}</td>
                                    <td class="p-4 text-slate-400">
                                        ${l.last_check ? new Date(l.last_check).toLocaleString('en-US', { timeZone: 'Asia/Yangon' }) : 'Pending...'}
                                    </td>
                                    <td class="p-4">
                                        ${
                                          l.status === 'active'
                                            ? '<span class="text-green-400 font-bold">✅ Active</span>'
                                            : l.status === 'failed'
                                              ? `<span class="text-red-400 font-bold" title="${l.error || ''}">❌ Failed</span>`
                                              : '<span class="text-yellow-500">⏳ Waiting</span>'
                                        }
                                    </td>
                                    <td class="p-4 text-right">
                                        <button onclick="deleteLink('${l.url}')" class="text-red-400 hover:text-red-300"><i class="fa-solid fa-trash"></i></button>
                                    </td>
                                </tr>
                            `
                              )
                              .join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
        <script>
            async function addLinks() {
                const text = document.getElementById('newLinks').value;
                if(!text.trim()) return;
                document.querySelector('button').innerText = "Saving...";
                await fetch('/api/add', {
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ links: text.split('\\n').map(l=>l.trim()).filter(l=>l) })
                });
                window.location.reload();
            }
            async function deleteLink(url) {
                if(!confirm("Delete?")) return;
                await fetch('/api/delete', { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url }) 
                });
                window.location.reload();
            }
            function runCheckNow() {
                if(!confirm("Run check now? This runs in the background.")) return;
                const btn = document.getElementById('checkBtn');
                btn.innerText = "⏳ Running...";
                btn.disabled = true;
                fetch('/api/trigger').then(res => res.text()).then(msg => {
                    alert(msg);
                    window.location.reload();
                }).catch(() => {
                    alert("Started in background... refresh page in a few minutes.");
                    window.location.reload();
                });
            }
        </script>
    </body>
    </html>
  `)
})

// --- API: Add Links ---
app.post('/api/add', async (c) => {
  const { links } = await c.req.json<{ links: string[] }>()
  for (const url of links) {
    const existing = await c.env.LINKS_KV.get(kvKey(url))
    if (!existing) {
      const data: LinkData = { url, status: 'pending', added_at: Date.now() }
      await c.env.LINKS_KV.put(kvKey(url), JSON.stringify(data))
    }
  }
  return c.json({ success: true })
})

// --- API: Delete Link ---
app.post('/api/delete', async (c) => {
  const { url } = await c.req.json<{ url: string }>()
  await c.env.LINKS_KV.delete(kvKey(url))
  return c.json({ success: true })
})

// --- API: Trigger Check ---
// waitUntil ကို သုံးပြီး background မှာ စစ်ပေးတယ်
app.get('/api/trigger', async (c) => {
  // c.executionCtx.waitUntil ကို သုံးပြီး response ပြန်ပြီးတဲ့နောက် background မှာ ဆက်စစ်တယ်
  const kv = c.env.LINKS_KV
  c.executionCtx.waitUntil(runMaintenance(kv))
  return c.text('✅ Check started in background! Refresh the page after a few minutes to see results.')
})

export default app
