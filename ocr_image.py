
try:
    from PIL import Image
    import pytesseract
    img = Image.open(r"C:\Users\I772848\AppData\Roaming\Joule Desktop\tmp\652ffd8e-6038-4ab8-b12f-ed5770395763\attachments\image.png")
    text = pytesseract.image_to_string(img)
    print("OCR OUTPUT:")
    print(text)
except ImportError as e:
    print(f"Missing library: {e}")
except Exception as e:
    print(f"Error: {e}")
