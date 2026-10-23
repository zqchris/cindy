"""Loopback-only deterministic API fixture. Never a real model or production service.
Use http://127.0.0.1:8987/v1, model fixture, empty API key in the simulator.
"""
import json
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PAGE = '''<!doctype html><html lang="zh"><meta name="viewport" content="width=device-width,initial-scale=1"><title>随身工作室</title><style>body{margin:0;background:#f4f2ed;color:#20241f;font:18px system-ui;padding:36px 24px}small{letter-spacing:3px;color:#657362}h1{font-size:42px;line-height:1.15;margin-top:60px}p{line-height:1.7;color:#657362}button{padding:16px 24px;border:0;border-radius:12px;background:#263d31;color:white;font:inherit}</style><small>CINDY · MOBILE</small><h1>灵感出现的地方，<br>就是工作室。</h1><p>这个文件由模拟器内的 Rust 核心保存。模型响应来自确定性测试服务。</p><button onclick="this.textContent='已开始'">开始创作</button></html>'''
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass  # No prompts, headers or keys in logs.
    def do_GET(self):
        if self.path != '/mobile-note.cindy': self.send_error(404); return
        from pathlib import Path
        from io import BytesIO
        import zipfile
        out=BytesIO()
        with zipfile.ZipFile(out,'w',zipfile.ZIP_DEFLATED) as archive:
            for path in (Path(__file__).parent/'mobile-note').iterdir(): archive.write(path,path.name)
        body=out.getvalue()
        self.send_response(200);self.send_header('Content-Type','application/octet-stream');self.send_header('Content-Disposition','attachment; filename="mobile-note.cindy"');self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
    def do_POST(self):
        if self.path != '/v1/chat/completions': self.send_error(404); return
        size=int(self.headers.get('Content-Length','0'))
        if size>1_000_000: self.send_error(413); return
        request=json.loads(self.rfile.read(size)); history=request['messages']; last=history[-1]
        text='验证完成。文件已经保存在当前任务，可打开“文件”查看。'; calls=[]
        if last['role']=='tool' and 'User declined' in last.get('content',''): text='你已拒绝这次操作，没有写入文件。'
        if last['role']=='user':
            prompt=last.get('content','')
            if 'slow' in prompt.lower(): time.sleep(12)
            name='write'; args={'path':'index.html','content':PAGE}
            if 'plugin' in prompt.lower():
                tool=next((t for t in request.get('tools',[]) if t['function']['name'].startswith('p_')),None)
                if tool: name=tool['function']['name']; args={'text':'Hello from the mobile extension'}
            elif 'edit' in prompt.lower(): name='edit';args={'path':'index.html','old':'随身工作室','new':'我的随身工作室'}
            elif 'list' in prompt.lower(): name='list';args={}
            calls=[{'id':str(uuid.uuid4()),'type':'function','function':{'name':name,'arguments':json.dumps(args,ensure_ascii=False)}}]
            text='我会把页面保存到当前任务。'
        message={'role':'assistant','content':text}
        if calls: message['tool_calls']=calls
        body=json.dumps({'choices':[{'message':message}]},ensure_ascii=False).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(body)));self.end_headers()
        try:self.wfile.write(body)
        except (BrokenPipeError,ConnectionResetError):pass
if __name__=='__main__':
    print('Deterministic test fixture listening on 127.0.0.1:8987',flush=True)
    ThreadingHTTPServer(('127.0.0.1',8987),Handler).serve_forever()
