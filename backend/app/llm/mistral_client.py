import os
import re
from dotenv import load_dotenv
from mistralai.client import Mistral

load_dotenv()

client = Mistral(api_key=os.getenv("MISTRAL_API_KEY"))
MODEL = os.getenv("MISTRAL_MODEL", "ministral-14b-latest")


def generate(prompt: str, json_mode: bool = False) -> str:
    """Send a single prompt to Mistral and return the text reply."""
    response = client.chat.complete(
        model=MODEL,
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"} if json_mode else None,
        # Structured answers (orders, matches, action items) should be consistent, not creative
        temperature=0.1 if json_mode else 0.5,
    )
    text = response.choices[0].message.content.strip()
    # Models sometimes wrap markdown answers in ```markdown fences despite being told not to
    text = re.sub(r"^```[a-z]*\s*\n", "", text)
    return re.sub(r"\n?```\s*$", "", text).strip()
