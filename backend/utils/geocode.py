import requests
from functools import lru_cache
from config import NOMINATIM_URL, USER_AGENT

@lru_cache(maxsize=1024)
def geocode_address(address):
    params = {"q": address, "format":"json", "limit":1}
    headers = {"User-Agent": USER_AGENT}
    try:
        resp = requests.get(NOMINATIM_URL, params=params, headers=headers, timeout=5)
        resp.raise_for_status()
        data = resp.json()
        if not data:
            return None
        return float(data[0]["lat"]), float(data[0]["lon"])
    except Exception:
        return None
