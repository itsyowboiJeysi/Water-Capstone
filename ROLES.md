# AgosTech — User Roles & Permissions Matrix

This document outlines the architecture, features, and role-based access control (RBAC) rules for **AgosTech: Smart Water Quality Monitoring and Management System** at Camarines Sur Polytechnic Colleges (CSPC).

---

## 1. Project Overview
AgosTech is an IoT-powered real-time water quality monitoring system designed for campus-wide safety. ESP32 microcontrollers measure physical and chemical water parameters and publish them via MQTT to a central Node.js backend. The system automatically classifies water safety using PNSDW (Philippine National Standards for Drinking Water) and WHO guidelines.

### Tech Stack:
* **Frontend:** HTML5, CSS3, Vanilla JavaScript, responsive grid layout.
* **Backend:** Node.js, Express, MySQL Database (`mysql2` pool), JWT-based auth.
* **IoT Protocol:** MQTT subscription on HiveMQ public broker (`esp32/agostech/#`).

---

## 2. User Roles & Access Matrix

The system enforces role gating on both the frontend dashboard and backend API endpoints, dividing access among three distinct roles: **Admin**, **GSU**, and **HSU**.

| Feature / Action | Admin | GSU (General Services Unit) | HSU (Health Services Unit) |
| :--- | :---: | :---: | :---: |
| **Real-time Dashboard Metrics** | View | View | View |
| **Detailed Water Safety Score & Use Recommendations** | View | View | View |
| **Sensor Readings Log** | View & Delete (Bulk) | View Only | View Only |
| **Monitored Buildings & Locations** | View & Manage (Create/Delete) | View Only | View Only |
| **ESP32 Devices Directory** | View & Manage (Create/Update/Delete) | View Only | View Only |
| **System Alerts & Notifications** | View, Resolve & Delete (Bulk) | View Only | View Only |
| **User Account Directory** | View & Manage (Role/Status/Delete) | No Access | No Access |
| **SMS Notification Logs** | View Only | View Only | View Only |
| **System Threshold Configuration** | View & Manage | View Only | View Only |

---

## 3. Detailed Role Descriptions

### 🔑 ADMIN (System Administrator)
The **Admin** has full read and write administrative privileges across the entire AgosTech platform. They are responsible for keeping the system running, enrolling users, configuring parameters, and managing physical hardware devices.
* **User Control:** Enrolls new accounts, updates user roles, deactivates inactive accounts, and deletes user profiles.
* **Location/Building Control:** Adds, updates, or deletes campus buildings monitored by the system.
* **Device Enrolment:** Registers new ESP32 monitoring devices, maps them to physical locations, and sets up their MQTT subscription topics.
* **Data Log Management:** Performs maintenance cleanup on database tables, including bulk deleting sensor readings and resolving or deleting alert notifications.
* **Threshold Settings:** Has the authority to update parameter thresholds (pH, Turbidity, TDS, Temperature, Ammonia, Flow Rate) to reflect changes in sanitary and plumbing standards.

### 🔧 GSU (General Services Unit)
The **General Services Unit** represents campus facility management and utility operations. They are the "hands-on" team responsible for physical plumbing, pipeline maintenance, addressing leakages, and equipment replacement.
* **Parameter Scope:** GSU monitors **Flow rate**, **pH level**, and **Turbidity** for campus pipeline health and facility operations.
* **Plumbing & Leak Detection:** Monitors flow rates across campus buildings. Sudden drops or spikes in flow rate logs alert them to possible line leakages or water shortages.
* **Hardware & Connectivity Checks:** Monitors device status (Online/Offline/Maintenance). If a device is marked offline by the periodic health checks, GSU inspects the physical sensor nodes for power outages or network failures.
* **Actionable Alerts Response:** Receives warnings about physical plumbing anomalies, ensuring they can target inspection runs to the correct building immediately.
* **Read-Only Access:** GSU has read-only access to all charts, tables, and sensor logs, meaning they can analyze patterns without the risk of deleting records.

### 🩺 HSU (Health Services Unit)
The **Health Services Unit** represents the school clinic and sanitary monitoring operations. They are responsible for student and staff welfare, ensuring that any water distributed on campus is safe for human contact and consumption.
* **Water Safety Surveillance:** Monitors the Water Safety Score (0-100) and the WHO/PNSDW suitability classification (Safe, Acceptable, Warning, Unsafe, Critical).
* **Usage Enforcement:** Reviews the "Recommended Uses" and "Not Recommended" lists. If a parameter exceeds critical boundaries (e.g. Ammonia > 1.5 mg/L or pH < 5.5), HSU uses this data to coordinate clinic warnings, suspend water drinking access, or advise campus-wide sanitation sweeps.
* **Parameter Trend Analysis:** Uses the Analytics dashboard to inspect average pH levels and turbidity trends to guarantee compliance with national sanitation regulations.
* **Security Guardrails:** HSU has read-only access to logs and device lists, keeping them fully informed of water safety levels without administrative editing access.
