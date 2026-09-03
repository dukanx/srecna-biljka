FROM python:3.12-slim

WORKDIR /app

COPY api/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY api/ .

ENV PORT=8080
EXPOSE 8080

CMD ["sh", "-c", "python db.py && gunicorn --bind 0.0.0.0:${PORT} --workers 2 --timeout 60 app:app"]
