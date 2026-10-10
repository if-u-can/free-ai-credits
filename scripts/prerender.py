#!/usr/bin/env python3
"""把 data/eggs.json 预渲染成静态 HTML 写进 index.html（供不执行 JS 的搜索引擎抓取），
并更新 sitemap.xml 的 lastmod。页面加载后原有 JS 会照常接管并替换这部分内容。"""
import json, re, html, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
data = json.loads((root/'data/eggs.json').read_text(encoding='utf-8'))
eggs = [e for e in data['eggs'] if e.get('status') in ('active', 'pending')]
rank = {'super': 0, 'premium': 1, 'normal': 2, None: 3}
label = {'super': '超级鸡蛋', 'premium': '优质鸡蛋', 'normal': '普通鸡蛋', None: '待核实'}
eggs.sort(key=lambda e: (rank.get(e.get('grade'), 3), e['name']))
esc = lambda v: html.escape("" if v is None else str(v))
items = []
for e in eggs:
    link = e.get('claim_url') or e.get('official_source_url') or e.get('url') or ''
    a = f'<a href="{esc(link)}" rel="noopener noreferrer" target="_blank">官方来源</a>' if link else ''
    items.append(
        f'<article class="seo-egg"><h3>{esc(e["name"])}（{label.get(e.get("grade"), "待核实")}）</h3>'
        f'<p>{esc(e.get("credits",""))}。{esc(e.get("description",""))}</p>'
        f'<p>领取条件：{esc(e.get("requirements",""))}｜是否绑卡：{esc(str(e.get("payment_required","未知")))}'
        f'｜最近核实：{esc(e.get("verified_at",""))} {a}</p></article>')
block = '<!--SEO:START-->' + ''.join(items) + '<!--SEO:END-->'
p = root/'index.html'
s = p.read_text(encoding='utf-8')
if '<!--SEO:START-->' in s:
    s = re.sub(r'<!--SEO:START-->.*?<!--SEO:END-->', lambda m: block, s, flags=re.S)
else:
    s = s.replace('id="cards">加载鸡蛋中…', 'id="cards">' + block + '加载鸡蛋中…', 1)
p.write_text(s, encoding='utf-8')
sm = root/'sitemap.xml'
if sm.exists():
    t = sm.read_text(encoding='utf-8')
    sm.write_text(re.sub(r'<lastmod>.*?</lastmod>', f'<lastmod>{data["updated_at"]}</lastmod>', t), encoding='utf-8')
print('prerendered', len(items), 'eggs')
