FROM python:3.12-slim

WORKDIR /app

COPY services/hippocampus-api/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# Copy the hippocampus source from the arceus reference
COPY _arceus-ref/backend /app/_arceus-ref/backend
COPY services/hippocampus-api/main.py /app/main.py

ENV PYTHONUNBUFFERED=1

EXPOSE 8100

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8100"]
