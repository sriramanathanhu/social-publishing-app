#!/usr/bin/env python3
"""Workspace cleanup utility to remove temporary files after processing"""

import os
import shutil
import time
from datetime import datetime, timedelta
from .utils import log

def cleanup_workspace(workspace_dir="workspace", keep_recent_hours=2, preserve_patterns=None):
    """
    Clean up workspace directory while preserving important files
    
    Args:
        workspace_dir: Path to workspace directory
        keep_recent_hours: Keep files modified within this many hours
        preserve_patterns: List of filename patterns to always preserve
    """
    if preserve_patterns is None:
        preserve_patterns = [
            "credentials.json",
            "*.lock",
            "published.lock",  # Important for tracking published content
            "vision.json",     # Video analysis results
            "transcript.json",  # Transcription results
            "captions.json",    # Generated captions
        ]
    
    if not os.path.exists(workspace_dir):
        log("CLEANUP", f"Workspace directory {workspace_dir} does not exist")
        return
    
    cutoff_time = datetime.now() - timedelta(hours=keep_recent_hours)
    cleaned_count = 0
    preserved_count = 0
    
    log("CLEANUP", f"Starting cleanup of {workspace_dir} (keeping files newer than {keep_recent_hours} hours)")
    
    for item in os.listdir(workspace_dir):
        item_path = os.path.join(workspace_dir, item)
        
        # Skip directories for now (like tts_clips)
        if os.path.isdir(item_path):
            continue
            
        # Check if file should be preserved
        should_preserve = False
        for pattern in preserve_patterns:
            if pattern.startswith("*."):
                # Wildcard pattern
                if item.endswith(pattern[1:]):
                    should_preserve = True
                    break
            else:
                # Exact match
                if item == pattern:
                    should_preserve = True
                    break
        
        if should_preserve:
            preserved_count += 1
            log("CLEANUP", f"Preserved: {item}")
            continue
        
        # Check file modification time
        try:
            mod_time = datetime.fromtimestamp(os.path.getmtime(item_path))
            if mod_time > cutoff_time:
                preserved_count += 1
                log("CLEANUP", f"Preserved (recent): {item}")
                continue
            
            # Remove old file
            os.remove(item_path)
            cleaned_count += 1
            log("CLEANUP", f"Removed: {item}")
            
        except Exception as e:
            log("CLEANUP", f"Failed to process {item}: {e}")
    
    log("CLEANUP", f"Cleanup complete: {cleaned_count} files removed, {preserved_count} files preserved")

def cleanup_flyer_files(workspace_dir="workspace"):
    """Clean up flyer-specific files after processing"""
    flyer_files = [
        "flyer_text.txt",
        "flyer_captions.json", 
        "flyer_teaser.json"
    ]
    
    if not os.path.exists(workspace_dir):
        return
    
    cleaned = 0
    for filename in flyer_files:
        file_path = os.path.join(workspace_dir, filename)
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
                cleaned += 1
                log("CLEANUP", f"Removed flyer file: {filename}")
            except Exception as e:
                log("CLEANUP", f"Failed to remove {filename}: {e}")
    
    if cleaned > 0:
        log("CLEANUP", f"Cleaned up {cleaned} flyer processing files")

def cleanup_temp_files(workspace_dir="workspace"):
    """Clean up temporary processing files"""
    temp_patterns = [
        "*.wav",
        "*.mp4", 
        "*.tmp",
        "temp_*",
        "output_*",
        "source_*"
    ]
    
    if not os.path.exists(workspace_dir):
        return
    
    cleaned = 0
    for item in os.listdir(workspace_dir):
        item_path = os.path.join(workspace_dir, item)
        
        # Skip directories and important files
        if os.path.isdir(item_path) or item in ["published.lock", "vision.json", "transcript.json", "captions.json"]:
            continue
            
        # Check if matches temp patterns
        is_temp = False
        for pattern in temp_patterns:
            if pattern.startswith("*."):
                if item.endswith(pattern[1:]):
                    is_temp = True
                    break
            elif "*" in pattern:
                # Simple wildcard matching
                if item.startswith(pattern.replace("*", "")):
                    is_temp = True
                    break
            else:
                if item == pattern:
                    is_temp = True
                    break
        
        if is_temp:
            try:
                os.remove(item_path)
                cleaned += 1
                log("CLEANUP", f"Removed temp file: {item}")
            except Exception as e:
                log("CLEANUP", f"Failed to remove {item}: {e}")
    
    if cleaned > 0:
        log("CLEANUP", f"Cleaned up {cleaned} temporary files")

def full_cleanup(workspace_dir="workspace"):
    """Perform complete workspace cleanup - wipe everything"""
    log("CLEANUP", "Starting complete workspace wipe")
    
    if not os.path.exists(workspace_dir):
        log("CLEANUP", f"Workspace {workspace_dir} does not exist")
        return
    
    cleaned = 0
    
    # Remove ALL files and directories
    for item in os.listdir(workspace_dir):
        item_path = os.path.join(workspace_dir, item)
        
        try:
            if os.path.isfile(item_path):
                os.remove(item_path)
                cleaned += 1
                log("CLEANUP", f"Removed file: {item}")
            elif os.path.isdir(item_path):
                # Remove directory and all contents
                import shutil
                shutil.rmtree(item_path)
                cleaned += 1
                log("CLEANUP", f"Removed directory: {item}")
        except Exception as e:
            log("CLEANUP", f"Failed to remove {item}: {e}")
    
    log("CLEANUP", f"Complete workspace wipe: {cleaned} items removed")
