"""Local JSON-lines bridge. BaoStock public data login needs no user account."""
import contextlib
import datetime
import json
import pathlib
import sys
from bounded_socket import install

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / '.runtime' / 'python-deps'))
import baostock as bs

install()
logged_in = False
for line in sys.stdin:
    phase = '解析请求'
    try:
        request = json.loads(line)
        phase = '连接登录'
        with contextlib.redirect_stdout(sys.stderr):
            if not logged_in:
                login = bs.login()
                if login.error_code != '0':
                    raise RuntimeError('BaoStock connection: ' + login.error_msg)
                logged_in = True
            phase = '查询日线'
            end = datetime.date.fromisoformat(request['asOf'])
            symbol = request['symbol']
            code = symbol[:2] + '.' + symbol[2:]
            result = bs.query_history_k_data_plus(
                code, 'date,code,open,close,high,low,volume,adjustflag,tradestatus',
                start_date=str(end-datetime.timedelta(days=400)),
                end_date=str(end), frequency='d', adjustflag='2')
            if result.error_code != '0':
                raise RuntimeError('BaoStock query: ' + result.error_msg)
            rows = []
            while result.next():
                rows.append(result.get_row_data())
            if result.error_code != '0':
                raise RuntimeError('BaoStock incomplete response: ' + result.error_msg)
        output = {'rows': rows[-180:], 'code': code}
    except Exception as error:
        logged_in = False
        output = {'error': phase + '：' + str(error)}
    print(json.dumps(output, ensure_ascii=True), flush=True)
if logged_in:
    with contextlib.redirect_stdout(sys.stderr):
        bs.logout()
