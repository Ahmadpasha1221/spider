#!/usr/bin/env python3
import sys

def main():
    print("=== Spider Health Check ===")
    print("Python environment: active")
    print(f"Arguments received: {sys.argv[1:]}")
    print("Health check completed successfully.")

if __name__ == "__main__":
    main()
